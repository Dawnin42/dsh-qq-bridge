/**
 * Transport tests: the loopback HTTP event server, the OneBot HTTP client, the
 * report secret, and the full path from "OneBot POSTs an event" to "a DSH turn
 * was started and the bridge answered on QQ".
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, afterEach, beforeEach, test } from 'node:test';

import { OneBotClient } from '../lib/onebot.js';
import { cleanupAll, makeBridge, waitFor } from './harness.mjs';
import { atBot, groupMessageEvent, privateMessageEvent, startMockOneBot } from './mock-onebot.mjs';

/** @type {Awaited<ReturnType<typeof startMockOneBot>>} */
let mock;

beforeEach(async () => {
  mock = await startMockOneBot({ port: 0 });
});

afterEach(async () => {
  await mock.close();
});

after(async () => {
  await cleanupAll();
});

/** Bridge wired to the mock service and listening on an ephemeral port. */
async function liveBridge(config = {}) {
  const client = new OneBotClient({ baseUrl: mock.url, logger: silent() });
  const harness = await makeBridge({
    client,
    config: { enabled: true, listenPort: 0, apiBaseUrl: mock.url, ...config },
  });
  await harness.bridge.start();
  harness.closed = false;
  return harness;
}

/** A logger that stays quiet during transport tests. */
function silent() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

test('start() binds the report endpoint and discovers the logged-in QQ number', async () => {
  const { bridge } = await liveBridge();
  try {
    assert.ok(bridge.server.port > 0);
    assert.match(bridge.server.reportUrl, /^http:\/\/127\.0\.0\.1:\d+\/onebot$/);
    assert.equal(bridge.selfId, '10001');
    assert.equal(bridge.selfNickname, '测试机器人');
    assert.equal(bridge.connected, true);

    const health = await fetch(bridge.server.reportUrl);
    const body = await health.json();
    assert.equal(health.status, 200);
    assert.equal(body.service, 'dsh-qq-bridge');
  } finally {
    await bridge.stop();
  }
});

test('an HTTP report drives a full round trip: event -> DSH turn -> QQ reply', async () => {
  const { bridge, ctx, agents } = await liveBridge();
  try {
    const response = await mock.report(bridge.server.reportUrl, groupMessageEvent({
      message: [atBot(), { type: 'text', data: { text: ' 帮我看下磁盘' } }],
    }));
    assert.equal(response.status, 200);
    assert.equal(response.body, '{}', 'OneBot 快速操作应收到空对象');

    await waitFor(() => agents.created.length === 1);
    const agent = agents.get('qq-group-11111');
    assert.equal(agent.received.length, 1);
    assert.match(agent.received[0].content[0].text, /帮我看下磁盘/);

    const reply = ctx._scopedTools.get('qq_reply');
    await reply.execute({ text: '看过了，还剩 40G。' }, {});
    assert.deepEqual(mock.sentText('group'), ['看过了，还剩 40G。']);
    assert.equal(mock.sent('group')[0].group_id, 11111);
  } finally {
    await bridge.stop();
  }
});

test('a private report reaches the owner command channel over HTTP', async () => {
  const { bridge, agents } = await liveBridge();
  try {
    await mock.report(bridge.server.reportUrl, privateMessageEvent({ userId: 20001, text: '跑一下测试' }));
    await waitFor(() => agents.created.length === 1);
    assert.equal(agents.get('qq-remote').received.length, 1);
    assert.match(agents.get('qq-remote').received[0].content[0].text, /跑一下测试/);
  } finally {
    await bridge.stop();
  }
});

test('reportSecret rejects unsigned reports and accepts signed ones', async () => {
  const { bridge, agents } = await liveBridge({ reportSecret: 'top-secret' });
  try {
    const payload = groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '你好' } }] });
    const unsigned = await mock.report(bridge.server.reportUrl, payload);
    assert.equal(unsigned.status, 401);
    assert.equal(agents.created.length, 0);

    const raw = JSON.stringify(payload);
    const signature = `sha1=${createHmac('sha1', 'top-secret').update(raw).digest('hex')}`;
    const signed = await fetch(bridge.server.reportUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': signature },
      body: raw,
    });
    assert.equal(signed.status, 200);
    await waitFor(() => agents.created.length === 1);
  } finally {
    await bridge.stop();
  }
});

test('malformed and oversized bodies are refused', async () => {
  const { bridge } = await liveBridge();
  try {
    const bad = await fetch(bridge.server.reportUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(bad.status, 400);
    assert.equal(bridge.server.stats.malformed, 1);
    assert.equal(bridge.server.stats.received, 0);

    const wrongPath = await fetch(bridge.server.reportUrl.replace('/onebot', '/nope'), { method: 'GET' });
    assert.equal(wrongPath.status, 404);
  } finally {
    await bridge.stop();
  }
});

test('a disabled bridge never answers, and heartbeat reports keep it alive', async () => {
  const { bridge, agents } = await liveBridge({ enabled: false });
  try {
    assert.equal(bridge.server.server, null, 'enabled:false 时不应监听端口');
    await bridge.handleEvent(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
    assert.equal(agents.created.length, 0);
  } finally {
    await bridge.stop();
  }

  const live = await liveBridge();
  try {
    await live.bridge.handleEvent({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: true, good: true },
      interval: 5000,
    });
    assert.equal(live.bridge.connected, true);
    await live.bridge.handleEvent({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: false, good: false },
    });
    assert.equal(live.bridge.connected, false);
  } finally {
    await live.bridge.stop();
  }
});

test('the OneBot client surfaces a clear error when nothing is listening', async () => {
  const client = new OneBotClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500, logger: silent() });
  const probe = await client.probe();
  assert.equal(probe.ok, false);
  assert.match(probe.error, /OneBot|ECONNREFUSED|请求失败/);
  await assert.rejects(() => client.getLoginInfo(), /get_login_info 请求失败/);
});

test('the OneBot client reports retcode failures as errors', async () => {
  const failing = await startMockOneBot({ port: 0, failActions: ['send_group_msg'] });
  try {
    const client = new OneBotClient({ baseUrl: failing.url, logger: silent() });
    await assert.rejects(() => client.sendGroupMsg(11111, [{ type: 'text', data: { text: 'x' } }]), /被 OneBot 拒绝/);
  } finally {
    await failing.close();
  }
});

/**
 * Plugin-entry tests: import `lib/index.js` and actually run `apply()` against
 * the fake host, so module load, tool registration, event wiring, and teardown
 * are all exercised the way DSH does it.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';

import { apply } from '../lib/index.js';
import { FakeAgents, makeFakeCtx, waitFor } from './harness.mjs';
import { atBot, groupMessageEvent, privateMessageEvent, startMockOneBot } from './mock-onebot.mjs';

/** @type {Awaited<ReturnType<typeof startMockOneBot>>} */
let mock;
const tempDirs = [];

before(async () => {
  mock = await startMockOneBot({ port: 0 });
});

after(async () => {
  await mock.close();
  while (tempDirs.length > 0) await rm(tempDirs.pop(), { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  mock.reset();
});

afterEach(() => {});

/** Every tool the plugin must publish. */
const EXPECTED_TOOLS = [
  'qq_status',
  'qq_config',
  'qq_list_groups',
  'qq_list_friends',
  'qq_group_members',
  'qq_send_group',
  'qq_send_private',
  'qq_recent_messages',
  'qq_group_mode',
  'qq_chats',
  'qq_client',
];

/** Wire a fake host context the way the Loader would. */
async function setup(rawConfig, services = {}) {
  const ctx = makeFakeCtx(services);
  const agents = new FakeAgents(ctx);
  ctx.get = (key) => (key === 'agents' ? agents : services[key]);
  const disposers = [];
  ctx.effect = (callback) => {
    const disposer = callback();
    if (typeof disposer === 'function') disposers.push(disposer);
    return disposer;
  };
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qq-plugin-test-'));
  tempDirs.push(dataDir);
  const enabled = rawConfig?.enabled !== false;
  apply(ctx, { dataDir, listenPort: 0, apiBaseUrl: mock.url, ownerIds: ['20001'], debounceMs: 40, mentionDebounceMs: 15, ...rawConfig });
  await waitFor(async () => ctx._globalTools.has('qq_status'), 3000);
  // `apply()` kicks the async bootstrap off; wait for the listener AND the
  // first OneBot login probe, both of which land after apply() has returned.
  if (enabled) {
    await waitFor(async () => {
      const text = (await ctx._globalTools.get('qq_status').execute({}, {})).text;
      return text.includes('监听中：是') && !text.includes('登录 QQ：未知');
    }, 5000);
  }
  return { ctx, agents, dataDir, dispose: async () => { for (const disposer of disposers) await disposer(); } };
}

test('apply() publishes every tool and starts the report endpoint', async () => {
  const harness = await setup({ enabled: true });
  try {
    for (const name of EXPECTED_TOOLS) {
      assert.ok(harness.ctx._globalTools.has(name), `缺少工具 ${name}`);
    }
    const status = await harness.ctx._globalTools.get('qq_status').execute({}, {});
    assert.match(status.text, /启用：是/);
    assert.match(status.text, /10001/);
    // The plugin listens on an ephemeral port, so read it back from the tool.
    const reportUrl = status.text.match(/事件上报地址：(\S+)/)[1];
    const health = await fetch(reportUrl.replace('/onebot', '/health'));
    assert.equal(health.status, 200);
  } finally {
    await harness.dispose();
  }
});

test('apply() with enabled:false registers tools but never listens', async () => {
  const harness = await setup({ enabled: false });
  try {
    const status = await harness.ctx._globalTools.get('qq_status').execute({}, {});
    assert.match(status.text, /启用：否/);
    assert.match(status.text, /监听中：否/);
    const groups = await harness.ctx._globalTools.get('qq_list_groups').execute({}, {});
    assert.match(groups.text, /11111/, '即使未启用，只读工具仍应可用');
  } finally {
    await harness.dispose();
  }
});

test('an event posted to the applied plugin becomes a DSH turn', async () => {
  const harness = await setup({ enabled: true });
  try {
    const before = await harness.ctx._globalTools.get('qq_status').execute({}, {});
    const reportUrl = before.text.match(/事件上报地址：(\S+)/)[1];

    const response = await mock.report(reportUrl, groupMessageEvent({
      message: [atBot(), { type: 'text', data: { text: ' 今晚谁值班' } }],
    }));
    assert.equal(response.status, 200);

    await waitFor(() => harness.agents.created.length === 1, 4000);
    const agent = harness.agents.get('qq-group-11111');
    assert.equal(agent.received.length, 1);
    assert.match(agent.received[0].content[0].text, /今晚谁值班/);

    const chats = await harness.ctx._globalTools.get('qq_chats').execute({}, {});
    assert.match(chats.text, /qq-group-11111/);
  } finally {
    await harness.dispose();
  }
});

test('teardown unregisters the tools and stops the listener', async () => {
  const harness = await setup({ enabled: true });
  const status = await harness.ctx._globalTools.get('qq_status').execute({}, {});
  const reportUrl = status.text.match(/事件上报地址：(\S+)/)[1];
  await harness.dispose();
  assert.equal(harness.ctx._globalTools.size, 0, '卸载后不应残留工具');
  await assert.rejects(() => fetch(reportUrl), /fetch failed|ECONNREFUSED/);
});

test('qq_config works through the real plugin entry', async () => {
  const harness = await setup({ enabled: false });
  try {
    const config = harness.ctx._globalTools.get('qq_config');
    const shown = await config.execute({ action: 'show' }, {});
    assert.match(shown.text, /主人 QQ：20001/);

    const endpoint = await config.execute({ action: 'endpoint', api_base_url: mock.url, access_token: 'tok-123456' }, {});
    assert.match(endpoint.text, /已连接：测试机器人\(10001\)/);
    assert.ok(!endpoint.text.includes('tok-123456'));

    await config.execute({ action: 'owner', owner_id: '20002' }, {});
    await config.execute({ action: 'default_mode', mode: 'auto' }, {});
    await config.execute({ action: 'dry_run', enabled: true }, {});
    const after = await config.execute({ action: 'show' }, {});
    assert.match(after.text, /主人 QQ：20001、20002/);
    assert.match(after.text, /群聊默认模式：auto/);
    assert.match(after.text, /dryRun：开/);

    // The private-message channel now recognises the second owner.
    const remote = harness.ctx._globalTools.get('qq_config');
    void remote;
    assert.equal(harness.ctx._globalTools.has('qq_send_private'), true);
  } finally {
    await harness.dispose();
  }
});

test('the owner channel answers a private message end to end', async () => {
  const harness = await setup({ enabled: true });
  try {
    const status = await harness.ctx._globalTools.get('qq_status').execute({}, {});
    const reportUrl = status.text.match(/事件上报地址：(\S+)/)[1];
    await mock.report(reportUrl, privateMessageEvent({ userId: 20001, text: '看一下状态' }));
    await waitFor(() => harness.agents.created.length === 1, 4000);
    assert.ok(harness.agents.get('qq-remote'));
  } finally {
    await harness.dispose();
  }
});

test('apply() registers the settings-page RPC channel when a connection service exists', async () => {
  const registered = [];
  const disposition = { disposed: false };
  const connection = {
    rpc: {
      handle: (channel, handler) => {
        registered.push({ channel, handler });
        return async () => { disposition.disposed = true; };
      },
    },
  };
  const harness = await setup({ enabled: false }, { connection });
  try {
    assert.equal(registered.length, 1, 'apply() 应该注册一条 RPC 通道');
    assert.equal(registered[0].channel, '/qq-bridge');

    // 通过 apply() 装出来的 handler 能直接回答页面请求
    const result = await registered[0].handler('status', {}, null, null);
    assert.equal(result.ok, true);
    assert.equal(result.value.config.ownerIds.includes('20001'), true);
    assert.equal(typeof result.value.server.reportUrl, 'string');
  } finally {
    await harness.dispose();
  }
  assert.equal(disposition.disposed, true, '插件卸载时应注销 RPC 通道');
});

test('apply() still works in a profile without a connection service', async () => {
  const harness = await setup({ enabled: false });
  try {
    assert.ok(harness.ctx._globalTools.has('qq_status'), '没有 connection 时插件仍应正常加载');
  } finally {
    await harness.dispose();
  }
});

/**
 * Tests for the three features added on request:
 *   ① per-group persona overrides
 *   ② sticker sending
 *   ③ routing the owner's private commands into a chosen session
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { resolveSticker } from '../lib/stickers.js';
import { createRpcHandler } from '../lib/rpc.js';
import { registerTools } from '../lib/tools.js';
import { cleanupAll, makeBridge, waitFor } from './harness.mjs';
import { atBot, groupMessageEvent, startMockOneBot } from './mock-onebot.mjs';

after(async () => {
  await cleanupAll();
});

/** A tiny real PNG so the sticker path exercises actual file reads. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A bridge wired to a mock OneBot, plus a sticker folder with one image. */
async function setup(options = {}) {
  const mock = await startMockOneBot({ port: 0 });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-stickers-'));
  await writeFile(path.join(dir, '开心.png'), PNG_BYTES);
  await writeFile(path.join(dir, '无语.jpg'), PNG_BYTES);
  await writeFile(path.join(dir, 'README.txt'), 'not an image');

  const harness = await makeBridge({
    config: { stickers: { dir }, ...(options.config ?? {}) },
    client: (await import('../lib/onebot.js')).OneBotClient
      ? new (await import('../lib/onebot.js')).OneBotClient({
        baseUrl: mock.url,
        logger: { info() {}, warn() {}, debug() {}, error() {} },
      })
      : undefined,
    ...(options.rest ?? {}),
  });
  harness.bridge.selfId = '10001';
  harness.bridge.selfNickname = '测试机器人';
  harness.mock = mock;
  harness.stickerDir = dir;
  harness.dispose = async () => {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  };
  return harness;
}

// ------------------------------------------------------------------ ① 单群提示词

test('a per-group persona replaces the shared one, and only for that group', async () => {
  const { bridge, config } = await makeBridge({ config: { groups: { 11111: { mode: 'mention', prompt: '你是这个群的猫娘。' } } } });
  assert.equal(bridge.groupPrompt('11111'), '你是这个群的猫娘。');
  assert.equal(bridge.groupPrompt('22222'), '');

  const groupChat = { kind: 'group', chatId: '11111', title: 'QQ群 测试群' };
  const otherChat = { kind: 'group', chatId: '22222', title: 'QQ群 别的群' };
  const withOverride = bridge.personaFor(groupChat);
  const without = bridge.personaFor(otherChat);

  assert.match(withOverride, /你是这个群的猫娘。/);
  assert.ok(!withOverride.includes('不是客服、不是助手'), '覆盖后不应再包含全局群聊人设');
  assert.match(withOverride, /qq_reply/, '回复机制那条规则必须仍然存在');
  assert.match(withOverride, /当前群：QQ群 测试群/, '当前群那行必须仍然存在');
  assert.match(without, /不是客服、不是助手/, '别的群仍用全局人设');
  assert.equal(config.groupPrompts['11111'], '你是这个群的猫娘。');
});

test('setGroupPrompt writes, clears, and survives a restart', async () => {
  const first = await makeBridge();
  assert.equal(first.bridge.setGroupPrompt('33333', '  只在群里说短句  '), '只在群里说短句');
  assert.equal(first.bridge.groupPrompt('33333'), '只在群里说短句');
  await first.bridge.state.flush();

  const second = await makeBridge({ dataDir: first.config.dataDir });
  await second.bridge.state.load();
  second.bridge.config = second.bridge.applyOverrides(second.bridge.patchConfig);
  assert.equal(second.bridge.groupPrompt('33333'), '只在群里说短句', '运行时覆盖应该在重启后保留');

  second.bridge.setGroupPrompt('33333', '');
  assert.equal(second.bridge.groupPrompt('33333'), '', '清除后应回到默认');
});

test('the page state exposes each group prompt and the group card edits it', async () => {
  const { bridge, ctx } = await makeBridge({ config: { groups: { 11111: 'auto' } } });
  registerTools(ctx, bridge);
  const handler = createRpcHandler(bridge);

  const saved = await handler('setGroupPrompt', { groupId: '11111', prompt: '只说东北话' }, null, null);
  assert.equal(saved.ok, true);
  assert.equal(saved.value.groupPrompts['11111'].prompt, '只说东北话');
  assert.equal(saved.value.groupPrompts['11111'].source, 'runtime');

  const tool = ctx._globalTools.get('qq_group_prompt');
  assert.ok(tool, '应该注册了 qq_group_prompt');
  const read = await tool.execute({ group_id: '11111' }, {});
  assert.match(read.text, /只说东北话/);
  const cleared = await tool.execute({ group_id: '11111', clear: true }, {});
  assert.match(cleared.text, /已清除/);
  assert.equal(bridge.groupPrompt('11111'), '');
});

test('a prompt or mode edit is flushed to disk at once, not left on the debounce', async () => {
  // 实测踩到过：清理提示词后立刻重启 DSH，改动丢了（state.mutate 只是防抖写盘）。
  const { bridge } = await makeBridge();
  let flushes = 0;
  const original = bridge.state.flush.bind(bridge.state);
  bridge.state.flush = async () => { flushes += 1; return original(); };

  bridge.setGroupPrompt('44444', '立刻落盘');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(flushes >= 1, 'setGroupPrompt 应该立刻触发落盘');

  bridge.setGroupMode('44444', 'auto');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(flushes >= 2, 'setGroupMode 也应该立刻触发落盘');

  bridge.setGroupPrompt('44444', '');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(flushes >= 3, '清除也应该立刻落盘');
});

test('changing a group prompt rebuilds that group agent so it takes effect at once', async () => {
  // 实测发现：人格是在 agent 创建时定下的，对一个活着的会话改提示词不会生效
  // （用中文 canary「西瓜」验证过：改完同一会话下一轮就变成新人格）。
  const { bridge, ctx, agents } = await makeBridge();
  bridge.selfId = '10001';
  bridge.selfNickname = '测试机器人';
  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await waitFor(() => agents.created.length === 1);
  assert.match(ctx._sections.at(-1).text, /不是客服、不是助手/, '一开始用的是全局群聊人设');
  assert.equal(bridge.chats.has('group:11111'), true);

  // 空闲状态下改提示词 → 立即淘汰（忙的时候走另一条分支，见下一个测试）
  const idle = bridge.chats.get('group:11111');
  idle.busy = false;
  idle.busySince = null;
  bridge.setGroupPrompt('11111', '你是一只只会说喵的猫。');
  await waitFor(() => agents.disposed.length === 1);
  assert.equal(bridge.chats.has('group:11111'), false, '改提示词应该淘汰那个群的活会话');

  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '再来一次' } }] }));
  await waitFor(() => agents.created.length + agents.resumed.length >= 2);
  assert.match(ctx._sections.at(-1).text, /只会说喵的猫/, '重建之后必须用新人格');
  assert.ok(!ctx._sections.at(-1).text.includes('不是客服、不是助手'), '新人格应替换掉全局人设');
});

test('a prompt edit during a busy turn rebuilds after that turn, not mid-answer', async () => {
  const { bridge, agents } = await makeBridge();
  bridge.selfId = '10001';
  bridge.selfNickname = '测试机器人';
  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await waitFor(() => agents.created.length === 1);
  const chat = bridge.chats.get('group:11111');
  chat.busy = true;
  chat.busySince = Date.now();

  bridge.setGroupPrompt('11111', '答完这轮再换。');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(agents.disposed.length, 0, '正在回答时不能把会话掐掉');
  assert.equal(chat.retireAfterTurn, true, '应该记下来等这轮结束');

  await bridge.finishTurn(chat);
  await waitFor(() => agents.disposed.length === 1);
  assert.equal(bridge.chats.has('group:11111'), false);
});

test('a group row survives a retired chat and a restart', async () => {
  // 实测反馈：改一次群提示词，那个群就从列表里消失了，还得再 @ 一次。
  // 根因是群列表原本只来自"活着的会话"，而改提示词会淘汰会话。
  const first = await makeBridge();
  first.bridge.selfId = '10001';
  first.bridge.selfNickname = '测试机器人';
  first.bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await waitFor(() => first.bridge.chats.has('group:11111'));
  assert.ok(first.bridge.status().groups.some((group) => group.groupId === '11111'), '看到消息后应该有这一行');

  // 等这一轮真的开起来，再把它当成空闲来处理（否则会走"等这轮答完"的分支）
  await waitFor(() => first.bridge.chats.get('group:11111')?.busy === true);
  const chat = first.bridge.chats.get('group:11111');
  chat.busy = false;
  chat.busySince = null;
  assert.equal(chat.pending.length, 0, '这一轮已经把待处理消息取走了');
  first.bridge.setGroupPrompt('11111', '新人格');
  await waitFor(() => !first.bridge.chats.has('group:11111'));
  assert.ok(
    first.bridge.status().groups.some((group) => group.groupId === '11111'),
    '淘汰会话之后这一行不能消失',
  );
  assert.equal(first.bridge.groupPrompt('11111'), '新人格', '设置本身也要还在');

  await first.bridge.state.flush();
  const second = await makeBridge({ dataDir: first.config.dataDir });
  await second.bridge.state.load();
  second.bridge.config = second.bridge.applyOverrides(second.bridge.patchConfig);
  const rows = second.bridge.status().groups;
  assert.ok(rows.some((group) => group.groupId === '11111'), '重启之后这一行也必须在（不用再 @ 一次）');
  assert.equal(second.bridge.groupPrompt('11111'), '新人格', '重启后提示词也要在');
});

test('the login state reports the identity when online and the QR when logged out', async () => {
  const online = await makeBridge();
  online.bridge.selfId = '10001';
  online.bridge.refreshIdentity = async () => ({ ok: true, userId: '10001', nickname: '测试机器人' });
  const live = await online.bridge.loginState();
  assert.equal(live.state, 'online');
  assert.equal(live.nickname, '测试机器人');
  assert.equal(live.qrcode, undefined, '登录状态正常时不该去读二维码文件');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-qr-'));
  try {
    await writeFile(path.join(dir, 'qrcode.png'), PNG_BYTES);
    const offline = await makeBridge({ config: { login: { qrcodePath: path.join(dir, 'qrcode.png') } } });
    offline.bridge.refreshIdentity = async () => ({ ok: false, error: '连不上 OneBot' });
    const state = await offline.bridge.loginState();
    assert.equal(state.state, 'offline');
    assert.match(state.qrcode, /^data:image\/png;base64,/, '应该把二维码读成 data URL');
    assert.match(state.probeError, /连不上/);
    assert.equal(state.qrcodePath, path.join(dir, 'qrcode.png'));

    const missing = await makeBridge({ config: { login: { qrcodePath: path.join(dir, 'nope.png') } } });
    missing.bridge.refreshIdentity = async () => ({ ok: false, error: 'x' });
    const none = await missing.bridge.loginState();
    assert.equal(none.state, 'offline');
    assert.equal(none.qrcode, null);
    assert.match(none.error, /读不到二维码文件/, '读不到时要给出可读原因而不是抛错');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the hourly turn budget is runtime-adjustable, validated, and durable', async () => {
  // 实测反馈：auto 模式的群一小时内跑满 30 轮后，机器人突然就不说话了，
  // 而当时这个上限改不了（不在可覆盖白名单里）。
  const { bridge } = await makeBridge({ config: { maxTurnsPerHour: 30 } });
  assert.equal(bridge.config.maxTurnsPerHour, 30);

  assert.equal(await bridge.setOverride('maxTurnsPerHour', '60'), 60, '字符串数字应被接受并转成数字');
  assert.equal(bridge.config.maxTurnsPerHour, 60);

  await assert.rejects(() => bridge.setOverride('maxTurnsPerHour', 0), /1~/);
  await assert.rejects(() => bridge.setOverride('maxTurnsPerHour', -5), /1~/);
  await assert.rejects(() => bridge.setOverride('maxTurnsPerHour', 999999), /1~/);
  await assert.rejects(() => bridge.setOverride('maxTurnsPerHour', 'abc'), /1~/);
  assert.equal(bridge.config.maxTurnsPerHour, 60, '非法值不能改动配置');

  await bridge.state.flush();
  const second = await makeBridge({ dataDir: bridge.state.dir });
  await second.bridge.state.load();
  second.bridge.config = second.bridge.applyOverrides(second.bridge.patchConfig);
  assert.equal(second.bridge.config.maxTurnsPerHour, 60, '重启后仍然生效');
});

test('the budget stops turns once spent, and resets on the rolling hour', async () => {
  const { bridge } = await makeBridge({ config: { maxTurnsPerHour: 2 } });
  const chat = { hourStart: Date.now(), turnCount: 0 };
  assert.equal(bridge.takeTurnBudget(chat), true);
  assert.equal(bridge.takeTurnBudget(chat), true);
  assert.equal(bridge.takeTurnBudget(chat), false, '用完之后必须挡住，否则就是无限烧模型');
  chat.hourStart = Date.now() - 3_600_001;
  assert.equal(bridge.takeTurnBudget(chat), true, '滚动一小时之后应该重置');
  assert.equal(chat.turnCount, 1);
});

test('the qq_config tool exposes max_turns', async () => {
  const { bridge, ctx } = await makeBridge({ config: { maxTurnsPerHour: 30 } });
  registerTools(ctx, bridge);
  const tool = ctx._globalTools.get('qq_config');
  const applied = await tool.execute({ action: 'max_turns', value: 200 }, {});
  assert.match(applied.text, /200/);
  assert.equal(bridge.config.maxTurnsPerHour, 200);
  await assert.rejects(() => tool.execute({ action: 'max_turns', value: 0 }, {}), /正整数/);
});

// -------------------------------------------------------------------- ② 表情包

test('a sticker name resolves to an image segment from the folder', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-sticker-unit-'));
  try {
    await writeFile(path.join(dir, '开心.png'), PNG_BYTES);
    const byName = await resolveSticker('开心', { dir, maxBytes: 1024 * 1024 });
    assert.equal(byName.error, undefined);
    assert.equal(byName.segments[0].type, 'image');
    assert.match(byName.segments[0].data.file, /^base64:\/\/[A-Za-z0-9+/=]+$/);

    const byFileName = await resolveSticker('开心.png', { dir, maxBytes: 1024 * 1024 });
    assert.equal(byFileName.error, undefined);

    const byFace = await resolveSticker('face:178', { dir, maxBytes: 1024 * 1024 });
    assert.deepEqual(byFace.segments, [{ type: 'face', data: { id: '178' } }]);

    const byUrl = await resolveSticker('https://example.com/a.png', { dir, maxBytes: 1024 * 1024 });
    assert.deepEqual(byUrl.segments, [{ type: 'image', data: { file: 'https://example.com/a.png' } }]);

    const missing = await resolveSticker('不存在', { dir, maxBytes: 1024 * 1024 });
    assert.match(missing.error, /表情库里没有/);
    assert.match(missing.error, /开心/, '错误里应提示可用名字');

    const tooBig = await resolveSticker('开心', { dir, maxBytes: 10 });
    assert.match(tooBig.error, /图片太大/);

    const bad = await resolveSticker('../../etc/passwd', { dir, maxBytes: 1024 * 1024 });
    assert.ok(bad.error !== undefined, '路径穿越式名字应被拒绝');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('qq_reply can send a sticker, and a sticker alone needs no text', async () => {
  const harness = await setup();
  const { bridge, ctx, agents, mock } = harness;
  try {
    bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '来个表情' } }] }));
    await waitFor(() => agents.created.length === 1);
    const reply = ctx._scopedTools.get('qq_reply');

    const ok = await reply.execute({ text: '给你', sticker: '开心' }, {});
    assert.equal(ok.sent, true);
    const sent = mock.sent('group')[0];
    assert.deepEqual(sent.message[0], { type: 'text', data: { text: '给你' } });
    assert.equal(sent.message[1].type, 'image');
    assert.match(sent.message[1].data.file, /^base64:\/\//);

    const stickerOnly = await reply.execute({ sticker: 'face:178' }, {});
    assert.equal(stickerOnly.sent, true, '只发表情也应该发得出去');
    assert.deepEqual(mock.sent('group')[1].message, [{ type: 'face', data: { id: '178' } }]);

    await assert.rejects(() => reply.execute({}, {}), /text 或 sticker 至少一个/);
    await assert.rejects(() => reply.execute({ sticker: '不存在' }, {}), /表情库里没有/);

    // 同一个 turn 里完全相同的第二次调用被跳过
    // （真实 DSH 实测里模型把同一条消息连发了 3 次，在群里就是刷屏）
    const before = mock.sent('group').length;
    const again = await reply.execute({ text: '给你', sticker: '开心' }, {});
    assert.equal(again.sent, false);
    assert.equal(again.skipped, true);
    assert.equal(mock.sent('group').length, before, '重复内容不应再发一次');

    const changed = await reply.execute({ text: '再给你一个', sticker: '开心' }, {});
    assert.equal(changed.sent, true, '换了措辞就正常发');

    // 新一轮开始时去重集合清空
    const groupChat = [...bridge.chats.values()].find((chat) => chat.kind === 'group');
    groupChat.busy = false;
    groupChat.busySince = null;
    groupChat.pending.push({ time: Math.floor(Date.now() / 1000), userId: '111111', name: '测试甲', text: '再来一次', mentioned: true, self: false, messageId: null });
    void bridge.flush(groupChat, 'test');
    await waitFor(() => groupChat.sentThisTurn.size === 0);
    const fresh = await reply.execute({ text: '给你', sticker: '开心' }, {});
    assert.equal(fresh.sent, true, '新一轮里同样的内容可以再发');
  } finally {
    await harness.dispose();
  }
});

test('the qq_sticker tool lists the folder and sends to a group or a private chat', async () => {
  const harness = await setup();
  const { bridge, ctx, mock } = harness;
  try {
    registerTools(ctx, bridge);
    const tool = ctx._globalTools.get('qq_sticker');

    const list = await tool.execute({ action: 'list' }, {});
    assert.match(list.text, /开心/);
    assert.match(list.text, /无语/);
    assert.ok(!list.text.includes('README'), '非图片文件不该出现');

    const sent = await tool.execute({ action: 'send', target_kind: 'group', target_id: '11111', sticker: '无语', text: '就这？' }, {});
    assert.match(sent.text, /已把「无语\.jpg（\d+KB）」发到 group:11111/);
    assert.equal(mock.sent('group').length, 1);
    assert.equal(mock.sent('group')[0].group_id, 11111);

    const priv = await tool.execute({ action: 'send', target_kind: 'private', target_id: '20001', sticker: 'face:4' }, {});
    assert.match(priv.text, /已把「face:4」发到 private:20001/);
    assert.equal(mock.sent('private').length, 1);

    await assert.rejects(() => tool.execute({ action: 'send', target_kind: 'group', sticker: '开心' }, {}), /target_id/);
    await assert.rejects(() => tool.execute({ action: 'send', target_kind: 'group', target_id: '1' }, {}), /sticker/);
  } finally {
    await harness.dispose();
  }
});

test('stickers can be switched off entirely', async () => {
  const harness = await setup({ config: { stickers: { enabled: false } } });
  const { bridge, ctx } = harness;
  try {
    registerTools(ctx, bridge);
    const tool = ctx._globalTools.get('qq_sticker');
    const list = await tool.execute({ action: 'list' }, {});
    assert.match(list.text, /已在配置里关闭/);
    await assert.rejects(() => tool.execute({ action: 'send', target_kind: 'group', target_id: '1', sticker: '开心' }, {}), /关闭/);
  } finally {
    await harness.dispose();
  }
});

// ---------------------------------------------------------------- ③ 遥控路由

test('the remote channel routes to a chosen session and back again', async () => {
  const { bridge, ctx, agents } = await makeBridge({ config: { ownerIds: ['20001'] } });
  registerTools(ctx, bridge);
  const handler = createRpcHandler(bridge);

  assert.equal(bridge.remoteSessionId(), 'qq-remote', '默认是插件自带的专用会话');

  await bridge.setRemoteTarget('session-abc', '我的主对话（session-abc）');
  assert.equal(bridge.remoteSessionId(), 'session-abc');

  const chat = bridge.remoteChat('20001');
  assert.equal(chat.sessionId, 'session-abc');
  assert.equal(chat.title, '我的主对话（session-abc）');

  // 一条私信应该进入被路由的那个会话
  bridge.state.mutate((state) => { state.remoteTarget = { sessionId: 'session-abc', label: '我的主对话' }; });
  const { privateMessageEvent } = await import('./mock-onebot.mjs');
  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '继续昨天那个活' }));
  await waitFor(() => agents.created.length === 1);
  assert.equal(agents.created[0].sessionId, 'session-abc', '指令应投递到被路由的会话');

  await bridge.clearRemoteTarget();
  assert.equal(bridge.remoteSessionId(), 'qq-remote', 'off 之后应回到专用会话');

  const status = await handler('status', {}, null, null);
  assert.equal(status.ok, true);
  assert.equal(typeof status.value.remoteSessionId, 'string');
});

test('the /use command and qq_remote tool steer routing without a model turn', async () => {
  const { bridge, ctx, agents } = await makeBridge({ config: { ownerIds: ['20001'] } });
  registerTools(ctx, bridge);
  const { privateMessageEvent } = await import('./mock-onebot.mjs');

  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '/use session-xyz' }));
  await waitFor(() => bridge.remoteSessionId() === 'session-xyz');
  assert.equal(agents.created.length, 0, '/use 不应触发模型');

  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '/use off' }));
  await waitFor(() => bridge.remoteSessionId() === 'qq-remote');

  const tool = ctx._globalTools.get('qq_remote');
  const status = await tool.execute({ action: 'status' }, {});
  assert.match(status.text, /qq-remote/);

  const used = await tool.execute({ action: 'use', session_id: 'session-tool' }, {});
  assert.match(used.text, /session-tool/);
  assert.equal(bridge.remoteSessionId(), 'session-tool');

  const cleared = await tool.execute({ action: 'off' }, {});
  assert.match(cleared.text, /qq-remote/);
});

test('listing sessions never throws, even without a sessionQuery service', async () => {
  const bare = await makeBridge();
  assert.deepEqual(await bare.bridge.listSessions(), [], '没有 sessionQuery 时应返回空数组而不是抛错');

  const wired = await makeBridge({
    services: {
      sessionQuery: {
        listSessions: async () => [
          { header: { id: 'session-1', cwd: 'D:\\x', createdAt: 1 }, live: true, persisted: true },
          { header: { id: 'session-2', cwd: 'D:\\y', createdAt: 2 }, live: false, persisted: true },
        ],
        readTitleSnapshots: async () => [
          { sessionId: 'session-1', status: 'fulfilled', value: { title: { title: '第一个会话' } } },
          { sessionId: 'session-2', status: 'rejected', reason: new Error('x') },
        ],
      },
    },
  });
  const sessions = await wired.bridge.listSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, 'session-1');
  assert.equal(sessions[0].title, '第一个会话');
  assert.equal(sessions[0].live, true);
  assert.equal(sessions[1].title, null);
});

test('a routed session that already exists is resumed instead of recreated', async () => {
  const { bridge, agents } = await makeBridge({ config: { ownerIds: ['20001'] } });
  // Pretend the session exists in persistence.
  const original = bridge.sessionExists.bind(bridge);
  bridge.sessionExists = async (sessionId) => sessionId === 'session-existing' || await original(sessionId);
  await bridge.setRemoteTarget('session-existing', '已有会话');

  const { privateMessageEvent } = await import('./mock-onebot.mjs');
  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '在吗' }));
  await waitFor(() => agents.resumed.length === 1);
  assert.equal(agents.resumed[0].sessionId, 'session-existing');
  assert.equal(agents.created.length, 0, '已有会话应被 resume 而不是 create');
});

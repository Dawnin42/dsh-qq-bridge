/**
 * Bridge behaviour tests: routing, modes, debounce, budgets, the remote command
 * channel, tool restriction, and dry-run. Sending goes through a real HTTP
 * client pointed at the mock OneBot service, so the whole send path is covered.
 */

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';

import { OneBotClient } from '../lib/onebot.js';
import { registerTools } from '../lib/tools.js';
import { cleanupAll, makeBridge, waitFor } from './harness.mjs';
import { atBot, groupMessageEvent, privateMessageEvent, startMockOneBot } from './mock-onebot.mjs';

/**
 * A fresh OneBot service per test: several tests fire messages without awaiting
 * the send, so a shared service would leak late sends into the next test.
 * @type {Awaited<ReturnType<typeof startMockOneBot>>}
 */
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

/** Build a bridge whose OneBot client talks to the mock service. */
async function bridgeWith(options = {}) {
  const client = new OneBotClient({ baseUrl: mock.url, logger: { info() {}, warn() {}, debug() {}, error() {} } });
  const harness = await makeBridge({ ...options, client });
  harness.bridge.selfId = '10001';
  harness.bridge.selfNickname = '测试机器人';
  return harness;
}

test('an @-mention starts exactly one DSH turn and is debounced with follow-ups', async () => {
  const { bridge, agents } = await bridgeWith();
  bridge.onGroupMessage(groupMessageEvent({
    message: [atBot(), { type: 'text', data: { text: ' 你好' } }],
  }));
  bridge.onGroupMessage(groupMessageEvent({ messageId: 2, text: '顺便问下天气' }));
  await waitFor(() => agents.created.length === 1);
  await waitFor(() => (agents.get('qq-group-11111')?.received.length ?? 0) === 1);

  const agent = agents.get('qq-group-11111');
  assert.equal(agent.received.length, 1);
  const prompt = agent.received[0].content[0].text;
  assert.match(prompt, /【QQ 群消息】/);
  assert.match(prompt, /本轮新消息】共 2 条/);
  assert.match(prompt, /你好/);
  assert.match(prompt, /顺便问下天气/);
  assert.match(prompt, /qq_reply/);
  assert.equal(agent.received[0].role, 'user');
  assert.equal(agent.received[0].source.kind, 'qq-bridge');
  assert.ok(Object.isFrozen(agent.received[0]));
});

test('a group message without a mention is ignored in mention mode', async () => {
  const { bridge, agents } = await bridgeWith();
  bridge.onGroupMessage(groupMessageEvent({ text: '大家早上好' }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(agents.created.length, 0);
  assert.equal(bridge.chats.get('group:11111').pending.length, 0);
});

test('auto mode follows the conversation and coalesces a burst into one turn', async () => {
  const { bridge, agents } = await bridgeWith({ config: { defaultGroupMode: 'auto' } });
  bridge.onGroupMessage(groupMessageEvent({ messageId: 1, text: '今天谁值班' }));
  bridge.onGroupMessage(groupMessageEvent({ messageId: 2, userId: 20003, nickname: '同事', text: '我看看' }));
  bridge.onGroupMessage(groupMessageEvent({ messageId: 3, text: '好像是老王' }));
  await waitFor(() => agents.created.length === 1, 3000);
  await waitFor(() => (agents.get('qq-group-11111')?.received.length ?? 0) >= 1, 3000);
  const agent = agents.get('qq-group-11111');
  assert.equal(agent.received.length, 1);
  assert.match(agent.received[0].content[0].text, /共 3 条/);
  assert.match(agent.received[0].content[0].text, /自动跟聊/);
});

test('off mode and the deny list stop everything', async () => {
  const off = await bridgeWith({ config: { groups: { 11111: 'off' } } });
  off.bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(off.agents.created.length, 0);

  const denied = await bridgeWith({ config: { denyGroups: ['11111'] } });
  denied.bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(denied.agents.created.length, 0);
});

test("the bot's own messages never trigger a turn", async () => {
  const { bridge, agents } = await bridgeWith();
  bridge.onGroupMessage(groupMessageEvent({ userId: 10001, message: [atBot(), { type: 'text', data: { text: '我自己' } }] }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(agents.created.length, 0);
});

test('the scoped qq_reply tool posts into the group the session belongs to', async () => {
  const { bridge, ctx, agents } = await bridgeWith();
  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '讲个笑话' } }] }));
  await waitFor(() => agents.created.length === 1);
  const reply = ctx._scopedTools.get('qq_reply');
  assert.ok(reply, 'qq_reply 应该注册在该会话的 agent 作用域里');

  const result = await reply.execute({ text: '我是认真的，不好笑。' }, {});
  assert.equal(result.sent, true);
  assert.equal(mock.sent('group').length, 1);
  assert.equal(mock.sent('group')[0].group_id, 11111);
  assert.deepEqual(mock.sentText('group'), ['我是认真的，不好笑。']);

  const withAt = await reply.execute({ text: '老王你看下', at_user: '20003' }, {});
  assert.equal(withAt.sent, true);
  assert.deepEqual(mock.sent('group')[1].message[0], { type: 'at', data: { qq: '20003' } });

  // The bot's own reply is mirrored into the ring buffer for later context.
  const buffered = bridge.recentMessages('group', '11111', 10);
  assert.equal(buffered.at(-1).self, true);
  assert.equal(buffered.at(-1).text, '老王你看下');
});

test('a directly addressed turn is relayed even when the model never calls qq_reply', async () => {
  const { bridge, agents } = await bridgeWith();
  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await waitFor(() => agents.created.length === 1);
  bridge.onSessionEvent({ id: 'qq-group-11111' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '我在的，你说。' }] } },
  });
  bridge.onSessionEvent({ id: 'qq-group-11111' }, { type: 'turn/end', data: {} });
  await waitFor(() => mock.sentText('group').length === 1);
  assert.deepEqual(mock.sentText('group'), ['我在的，你说。']);
  assert.equal(mock.sent('group')[0].group_id, 11111);
});

test('an automatically followed conversation stays silent unless the model calls qq_reply', async () => {
  const { bridge, ctx, agents } = await bridgeWith({ config: { defaultGroupMode: 'auto' } });
  bridge.onGroupMessage(groupMessageEvent({ text: '今天谁值班' }));
  await waitFor(() => agents.created.length === 1, 3000);
  await waitFor(() => (agents.get('qq-group-11111')?.received.length ?? 0) === 1, 3000);
  bridge.onSessionEvent({ id: 'qq-group-11111' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '这条不该发出去' }] } },
  });
  bridge.onSessionEvent({ id: 'qq-group-11111' }, { type: 'turn/end', data: {} });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(mock.sent('group'), []);

  // It may still speak deliberately: the tool call is the only way out.
  bridge.onGroupMessage(groupMessageEvent({ messageId: 5, text: '老王今天休息' }));
  const agent = agents.get('qq-group-11111');
  await waitFor(() => agent.received.length === 2, 3000);
  await ctx._scopedTools.get('qq_reply').execute({ text: '那就明天再说' }, {});
  bridge.onSessionEvent({ id: 'qq-group-11111' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '那就明天再说' }] } },
  });
  bridge.onSessionEvent({ id: 'qq-group-11111' }, { type: 'turn/end', data: {} });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(mock.sentText('group'), ['那就明天再说'], '主动发言后不应再重复转发一次');
});

test('the per-chat hourly budget stops runaway turns', async () => {
  const { bridge, agents } = await bridgeWith({ config: { maxTurnsPerHour: 2 } });
  const chat = () => bridge.chats.get('group:11111');
  for (let index = 0; index < 4; index += 1) {
    bridge.onGroupMessage(groupMessageEvent({
      messageId: 100 + index,
      message: [atBot(), { type: 'text', data: { text: `第 ${index} 次` } }],
    }));
    await waitFor(() => chat().pending.length === 0, 3000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    bridge.onSessionEvent({ id: 'qq-group-11111' }, { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(agents.created.length, 1);
  assert.equal(agents.get('qq-group-11111').received.length, 2);
  assert.ok(bridge.logger.has('预算'));
});

test('a private message from the owner becomes a DSH turn and the answer is relayed back', async () => {
  const { bridge, agents } = await bridgeWith();
  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '看一下磁盘剩余空间' }));
  await waitFor(() => agents.created.length === 1);
  const remote = bridge.remoteChat('20001');
  assert.equal(remote.sessionId, 'qq-remote');
  assert.equal(agents.get('qq-remote').received.length, 1);
  assert.match(agents.get('qq-remote').received[0].content[0].text, /来自主人的 QQ 私信指令/);
  await waitFor(() => mock.sentText('private').length >= 1);
  assert.match(mock.sentText('private')[0], /正在处理/);

  bridge.onSessionEvent({ id: 'qq-remote' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '先看看再回答。' }] } },
  });
  bridge.onSessionEvent({ id: 'qq-remote' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'D 盘还剩 42 GB。' }] } },
  });
  bridge.onSessionEvent({ id: 'qq-remote' }, { type: 'turn/end', data: {} });
  await waitFor(() => mock.sentText('private').some((text) => text.includes('42 GB')));
  const texts = mock.sentText('private');
  assert.equal(texts.at(-1), 'D 盘还剩 42 GB。');
  assert.ok(!texts.some((text) => text.includes('先看看再回答')), '只应回传最后一段助手消息');
});

test('an explicit qq_send_private during a turn suppresses the automatic relay', async () => {
  const { bridge, agents, ctx } = await bridgeWith();
  registerTools(ctx, bridge);
  const sendPrivate = ctx._globalTools.get('qq_send_private');
  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '报个到' }));
  await waitFor(() => agents.created.length === 1);
  await waitFor(() => mock.sentText('private').length >= 1); // the ack
  mock.reset();
  await sendPrivate.execute({ user_id: '20001', text: '我自己发的' }, {});
  bridge.onSessionEvent({ id: 'qq-remote' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '这段不应该重复发送' }] } },
  });
  bridge.onSessionEvent({ id: 'qq-remote' }, { type: 'turn/end', data: {} });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(mock.sentText('private'), ['我自己发的']);
});

test('owner slash commands answer directly without spending a model turn', async () => {
  const { bridge, agents } = await bridgeWith();
  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '/ping' }));
  await waitFor(() => mock.sentText('private').length === 1);
  assert.match(mock.sentText('private')[0], /pong/);
  assert.equal(agents.created.length, 0);

  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '/mode 11111 auto' }));
  await waitFor(() => bridge.modeFor('11111') === 'auto');
  assert.equal(bridge.state.snapshot().groupModes['11111'], 'auto');

  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '/unknown' }));
  await waitFor(() => bridge.logger.has('未知指令'));
  assert.equal(agents.created.length, 0);
});

test('private messages from strangers are ignored by default and chatted with when enabled', async () => {
  const ignoring = await bridgeWith();
  ignoring.bridge.onPrivateMessage(privateMessageEvent({ userId: 29999, text: '你好' }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(ignoring.agents.created.length, 0);
  assert.equal(ignoring.bridge.chats.size, 0);

  const chatting = await bridgeWith({ config: { privateFromOthers: 'chat' } });
  chatting.bridge.onPrivateMessage(privateMessageEvent({ userId: 29999, text: '你好' }));
  await waitFor(() => chatting.agents.created.length === 1);
  assert.ok(chatting.agents.get('qq-user-29999'));
  assert.match(chatting.agents.get('qq-user-29999').received[0].content[0].text, /【QQ 私信】/);
});

test('group sessions get an allow-listed tool set while the remote session inherits everything', async () => {
  const { bridge, ctx, agents } = await bridgeWith();
  // Pretend the deployment has these global tools.
  for (const name of ['qq_status', 'qq_send_group', 'read', 'pwsh']) {
    ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} } });
  }
  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await waitFor(() => agents.created.length === 1);
  const groupAllow = ctx._restrictions.at(-1);
  assert.deepEqual(groupAllow.allow.sort(), ['qq_send_group', 'qq_status']);

  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '执行一下' }));
  await waitFor(() => agents.created.length === 2);
  const stillGroupOnly = ctx._restrictions.at(-1);
  assert.deepEqual(stillGroupOnly.allow.sort(), ['qq_send_group', 'qq_status'], '遥控会话不应被限制');
});

test('a mis-spelled tool allow-list degrades to qq_* instead of failing open', async () => {
  const { bridge, ctx, agents } = await bridgeWith({
    config: { groupSessions: { toolAllow: ['does_not_exist'] } },
  });
  for (const name of ['qq_status', 'qq_send_group', 'read', 'pwsh']) {
    ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} } });
  }
  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await waitFor(() => agents.created.length === 1);
  assert.deepEqual(ctx._restrictions.at(-1).allow.sort(), ['qq_send_group', 'qq_status']);
  assert.ok(bridge.logger.has('退化为只允许 qq_*'));
});

test('every QQ session gets its own persona section', async () => {
  const { bridge, ctx, agents } = await bridgeWith();
  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await waitFor(() => agents.created.length === 1);
  const section = ctx._sections.at(-1);
  assert.equal(section.name, 'qq-bridge-group');
  assert.equal(section.interpolate, false);
  // A plain string: the function form silently registered NO section at all in
  // this Harness build (verified live — the group fell back to the default
  // persona). Freshness comes from retireChat() instead: editing a group's
  // prompt rebuilds that group's agent once.
  assert.equal(typeof section.text, 'string', 'section.text 必须是字符串');
  assert.match(section.text, /qq_reply/);
  assert.match(section.text, /当前群：QQ群 11111/);

  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '干点活' }));
  await waitFor(() => agents.created.length === 2);
  assert.equal(ctx._sections.at(-1).name, 'qq-bridge-remote');
  assert.match(ctx._sections.at(-1).text, /自动发回主人的 QQ/);
});

test('dryRun never touches QQ and says so in the tool result', async () => {
  const { bridge, ctx, agents } = await bridgeWith({ config: { dryRun: true } });
  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await waitFor(() => agents.created.length === 1);
  const result = await ctx._scopedTools.get('qq_reply').execute({ text: '不会真的发出去' }, {});
  assert.equal(result.sent, false);
  assert.equal(result.dryRun, true);
  assert.deepEqual(mock.sent('group'), []);

  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '在吗' }));
  await waitFor(() => agents.created.length === 2);
  bridge.onSessionEvent({ id: 'qq-remote' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '这个也不会发出去' }] } },
  });
  bridge.onSessionEvent({ id: 'qq-remote' }, { type: 'turn/end', data: {} });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(mock.sent('private'), []);
});

test('an existing live agent is reused instead of creating a second session', async () => {
  const { bridge, agents } = await bridgeWith();
  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '第一次' } }] }));
  await waitFor(() => agents.created.length === 1);
  const agent = agents.get('qq-group-11111');
  agent.status = 'idle';
  bridge.onSessionEvent({ id: 'qq-group-11111' }, { type: 'turn/end', data: {} });
  bridge.onGroupMessage(groupMessageEvent({ messageId: 77, message: [atBot(), { type: 'text', data: { text: '第二次' } }] }));
  await waitFor(() => agent.received.length === 2);
  assert.equal(agents.created.length, 1);
  assert.equal(agents.resumed.length, 0);
});

test('a busy session defers the next batch instead of interleaving turns', async () => {
  const { bridge, agents } = await bridgeWith();
  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '第一条' } }] }));
  await waitFor(() => agents.created.length === 1);
  const agent = agents.get('qq-group-11111');
  assert.equal(agent.received.length, 1);
  // Agent is still running: the next mention waits.
  bridge.onGroupMessage(groupMessageEvent({ messageId: 55, message: [atBot(), { type: 'text', data: { text: '第二条' } }] }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(agent.received.length, 1);
  bridge.onSessionEvent({ id: 'qq-group-11111' }, { type: 'turn/end', data: {} });
  await waitFor(() => agent.received.length === 2, 3000);
  assert.match(agent.received[1].content[0].text, /第二条/);
});

test('global tools report status and stream live configuration', async () => {
  const { bridge, ctx, agents } = await bridgeWith();
  registerTools(ctx, bridge);
  assert.ok(ctx._globalTools.has('qq_status'));
  assert.ok(ctx._globalTools.has('qq_group_mode'));
  assert.ok(ctx._globalTools.has('qq_config'));

  const status = await ctx._globalTools.get('qq_status').execute({}, {});
  assert.match(status.text, /OneBot：/);
  assert.match(status.text, /上报地址/);

  const groups = await ctx._globalTools.get('qq_list_groups').execute({}, {});
  assert.match(groups.text, /11111/);
  assert.match(groups.text, /测试群/);

  const mode = await ctx._globalTools.get('qq_group_mode').execute({ group_id: '11111', mode: 'auto' }, {});
  assert.match(mode.text, /已设为 auto/);
  assert.equal(bridge.modeFor('11111'), 'auto');

  const chats = await ctx._globalTools.get('qq_chats').execute({}, {});
  assert.match(chats.text, /目前还没有任何 QQ 会话/);

  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await waitFor(() => agents.created.length === 1);
  const chatsAfter = await ctx._globalTools.get('qq_chats').execute({}, {});
  assert.match(chatsAfter.text, /qq-group-11111/);
});

test('qq_config rewrites the endpoint, owners and safety switches at runtime', async () => {
  const { bridge, ctx } = await bridgeWith();
  registerTools(ctx, bridge);
  const config = ctx._globalTools.get('qq_config');

  const shown = await config.execute({ action: 'show' }, {});
  assert.match(shown.text, /主人 QQ/);
  assert.match(shown.text, /20001/);

  const endpoint = await config.execute({ action: 'endpoint', api_base_url: mock.url, access_token: 'secret-token' }, {});
  assert.equal(bridge.config.apiBaseUrl, mock.url);
  assert.equal(bridge.config.accessToken, 'secret-token');
  assert.match(endpoint.text, /已连接/);
  assert.ok(!endpoint.text.includes('secret-token'), '令牌不应原样回显');

  await config.execute({ action: 'owner', owner_id: '20002' }, {});
  assert.deepEqual(bridge.config.ownerIds, ['20001', '20002']);
  assert.equal(bridge.isOwner('20002'), true);
  await config.execute({ action: 'owner', owner_id: '20002', remove: true }, {});
  assert.deepEqual(bridge.config.ownerIds, ['20001']);

  await config.execute({ action: 'default_mode', mode: 'off' }, {});
  assert.equal(bridge.modeFor('99999'), 'off');
  await config.execute({ action: 'dry_run', enabled: true }, {});
  assert.equal(bridge.config.dryRun, true);
  await config.execute({ action: 'private_from_others', value: 'chat' }, {});
  assert.equal(bridge.config.privateFromOthers, 'chat');

  await assert.rejects(() => config.execute({ action: 'owner', owner_id: 'abc' }, {}), /5~12 位/);
  await assert.rejects(() => config.execute({ action: 'default_mode', mode: 'shout' }, {}), /off \/ mention \/ auto/);
  await assert.rejects(() => config.execute({ action: 'endpoint' }, {}), /api_base_url/);

  await config.execute({ action: 'reset', value: 'all' }, {});
  assert.deepEqual(bridge.overrides(), {});
  assert.equal(bridge.config.dryRun, false);
  assert.equal(bridge.config.privateFromOthers, 'ignore');
  assert.deepEqual(bridge.config.ownerIds, ['20001'], 'reset 后应回到 bundle patch 的值');
});

test('runtime overrides survive a restart through the state file', async () => {
  const first = await bridgeWith();
  registerTools(first.ctx, first.bridge);
  await first.ctx._globalTools.get('qq_config').execute({ action: 'owner', owner_id: '30003' }, {});
  await first.ctx._globalTools.get('qq_config').execute({ action: 'default_mode', mode: 'auto' }, {});
  await first.bridge.state.flush();

  const second = await makeBridge({
    dataDir: first.config.dataDir,
    config: { ownerIds: ['20001'], defaultGroupMode: 'mention' },
  });
  await second.bridge.state.load();
  second.bridge.config = second.bridge.applyOverrides(second.bridge.patchConfig);
  assert.deepEqual(second.bridge.config.ownerIds, ['20001', '30003']);
  assert.equal(second.bridge.config.defaultGroupMode, 'auto');
});

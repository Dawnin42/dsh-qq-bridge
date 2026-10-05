/**
 * A tiny stand-in for a local OneBot v11 HTTP service.
 *
 * It implements the API calls the bridge makes, records everything that was
 * sent, and can push events into a bridge's report endpoint. Run it directly
 * for a manual smoke test:
 *
 *   node test/mock-onebot.mjs --port 3010 --report http://127.0.0.1:8799/onebot
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** Create the mock service. */
export async function startMockOneBot(options = {}) {
  const port = options.port ?? 3010;
  const host = options.host ?? '127.0.0.1';
  /** @type {Array<{action: string, params: any, at: number}>} */
  const calls = [];
  const state = {
    selfId: options.selfId ?? 10001,
    nickname: options.nickname ?? '测试机器人',
    groups: options.groups ?? [
      { group_id: 11111, group_name: '测试群', member_count: 3, max_member_count: 200 },
      { group_id: 22222, group_name: '安静群', member_count: 5, max_member_count: 200 },
    ],
    friends: options.friends ?? [
      { user_id: 20001, nickname: '主人', remark: '' },
      { user_id: 20002, nickname: '路人', remark: '' },
    ],
    nextMessageId: 9000,
    failActions: new Set(options.failActions ?? []),
  };

  const groupMembers = (groupId) => [
    { user_id: state.selfId, nickname: state.nickname, card: '', role: 'member' },
    { user_id: 20001, nickname: '主人', card: '群主大人', role: 'owner' },
    { user_id: 20002, nickname: '路人', card: '', role: 'member' },
  ].map((member) => ({ ...member, group_id: Number(groupId) }));

  const server = http.createServer((request, response) => {
    const url = request.url ?? '/';
    // Debug view: what has the bridge asked this service to do?
    if (request.method === 'GET' && url.startsWith('/_calls')) {
      respond(response, 200, {
        calls: calls.map((call) => ({ action: call.action, params: call.params })),
        summary: calls.reduce((acc, call) => {
          acc[call.action] = (acc[call.action] ?? 0) + 1;
          return acc;
        }, {}),
      });
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let params = {};
      try {
        params = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        respond(response, 400, { status: 'failed', retcode: 1400, message: 'bad json' });
        return;
      }
      const action = (request.url ?? '/').replace(/^\//, '').split('?')[0];
      calls.push({ action, params, at: Date.now() });
      if (state.failActions.has(action)) {
        respond(response, 200, { status: 'failed', retcode: 1404, message: `${action} 被 mock 拒绝` });
        return;
      }
      const data = handle(action, params);
      if (data === undefined) {
        respond(response, 200, { status: 'failed', retcode: 1404, message: `unknown action ${action}` });
        return;
      }
      respond(response, 200, { status: 'ok', retcode: 0, data });
    });
  });

  function handle(action, params) {
    switch (action) {
      case 'get_login_info':
        return { user_id: state.selfId, nickname: state.nickname };
      case 'get_status':
        return { online: true, good: true };
      case 'get_version_info':
        return { app_name: 'mock-onebot', app_version: '1.0.0', protocol_version: 'v11' };
      case 'get_group_list':
        return state.groups;
      case 'get_friend_list':
        return state.friends;
      case 'get_group_member_list':
        return groupMembers(params.group_id);
      case 'get_group_member_info':
        return groupMembers(params.group_id).find((member) => member.user_id === Number(params.user_id)) ?? {};
      case 'get_stranger_info':
        return { user_id: Number(params.user_id), nickname: '陌生人' };
      case 'send_group_msg':
      case 'send_private_msg':
        return { message_id: state.nextMessageId++ };
      case 'delete_msg':
      case 'get_msg':
        return {};
      default:
        return undefined;
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const url = `http://${host}:${typeof address === 'object' && address !== null ? address.port : port}`;

  return {
    url,
    state,
    calls,
    /** Every message the bridge sent, in order. */
    sent(kind) {
      return calls
        .filter((call) => call.action === (kind === 'group' ? 'send_group_msg' : 'send_private_msg'))
        .map((call) => call.params);
    },
    sentText(kind) {
      return this.sent(kind).map((params) => (Array.isArray(params.message)
        ? params.message.filter((segment) => segment.type === 'text').map((segment) => segment.data.text).join('')
        : String(params.message)));
    },
    reset() {
      calls.length = 0;
    },
    /** Push one event into a bridge report endpoint. */
    async report(reportUrl, payload) {
      const response = await fetch(reportUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.text() };
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 1000).unref?.();
      });
    },
  };
}

/** Write one JSON response. */
function respond(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(text);
}

/** Build a OneBot v11 group-message event. */
export function groupMessageEvent(fields) {
  const userId = fields.userId ?? 20002;
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: fields.selfId ?? 10001,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: fields.messageId ?? Math.floor(Math.random() * 100000),
    group_id: fields.groupId ?? 11111,
    user_id: userId,
    raw_message: fields.raw ?? '',
    message: fields.message ?? [{ type: 'text', data: { text: fields.text ?? '' } }],
    sender: {
      user_id: userId,
      nickname: fields.nickname ?? '路人',
      card: fields.card ?? '',
      role: fields.role ?? 'member',
    },
  };
}

/** Build a OneBot v11 private-message event. */
export function privateMessageEvent(fields) {
  const userId = fields.userId ?? 20001;
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: fields.selfId ?? 10001,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: fields.messageId ?? Math.floor(Math.random() * 100000),
    user_id: userId,
    raw_message: fields.raw ?? '',
    message: fields.message ?? [{ type: 'text', data: { text: fields.text ?? '' } }],
    sender: { user_id: userId, nickname: fields.nickname ?? '主人' },
  };
}

/** An @-mention segment for the bot. */
export function atBot(selfId = 10001) {
  return { type: 'at', data: { qq: String(selfId) } };
}

// Manual smoke run: node test/mock-onebot.mjs --port 3010
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 3010;
  const reportIndex = process.argv.indexOf('--report');
  const reportUrl = reportIndex >= 0 ? process.argv[reportIndex + 1] : null;
  const mock = await startMockOneBot({ port });
  console.log(`mock OneBot HTTP API: ${mock.url}`);
  if (reportUrl !== null) {
    console.log(`示例：向 ${reportUrl} 推一条 @ 机器人的群消息`);
    setInterval(() => {
      void mock.report(reportUrl, groupMessageEvent({
        text: `现在几点？（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`,
        message: [atBot(), { type: 'text', data: { text: ' 现在几点？' } }],
      }));
    }, 5000).unref?.();
  }
}

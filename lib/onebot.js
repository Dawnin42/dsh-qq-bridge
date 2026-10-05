/**
 * OneBot v11 transport: an HTTP API client plus the loopback HTTP server that
 * receives "HTTP POST report" events.
 *
 * The design is deliberately implementation-agnostic: NapCat, SnowLuma,
 * Lagrange, LLOneBot and anything else speaking OneBot v11 over HTTP work
 * unchanged.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

/** Failure raised by the OneBot HTTP API, with the action and retcode kept. */
export class OneBotError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'OneBotError';
    this.action = details.action;
    this.retcode = details.retcode;
    this.status = details.status;
    this.httpStatus = details.httpStatus;
    this.aborted = details.aborted === true;
  }
}

/** Human-readable cause for a fetch failure. */
function describeFetchError(error) {
  const cause = error?.cause;
  const code = cause?.code ?? error?.code;
  if (code === 'ECONNREFUSED') return 'OneBot 服务未启动或地址/端口不对 (ECONNREFUSED)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'OneBot 主机名无法解析 (ENOTFOUND)';
  if (code === 'ETIMEDOUT') return '连接 OneBot 超时 (ETIMEDOUT)';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'OneBot 请求超时';
  return error?.message ?? String(error);
}

/** One OneBot v11 HTTP API client. */
export class OneBotClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl HTTP API root, e.g. http://127.0.0.1:3000
   * @param {string} [options.accessToken]
   * @param {number} [options.timeoutMs]
   * @param {{warn: Function, info: Function, debug: Function, error: Function}} options.logger
   */
  constructor(options) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.accessToken = options.accessToken ?? '';
    this.timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
    this.logger = options.logger;
  }

  /** Apply a config change without rebuilding the client. */
  configure(patch) {
    if (typeof patch.baseUrl === 'string') this.baseUrl = normalizeBaseUrl(patch.baseUrl);
    if (typeof patch.accessToken === 'string') this.accessToken = patch.accessToken;
    if (Number.isSafeInteger(patch.timeoutMs) && patch.timeoutMs > 0) this.timeoutMs = patch.timeoutMs;
  }

  /** Call one OneBot action and return its `data` field. */
  async call(action, params = {}, options = {}) {
    const url = `${this.baseUrl}/${action}`;
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : this.timeoutMs;
    const headers = { 'content-type': 'application/json' };
    if (this.accessToken.length > 0) headers.authorization = `Bearer ${this.accessToken}`;
    const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params ?? {}),
        signal,
      });
    } catch (error) {
      throw new OneBotError(`${action} 请求失败：${describeFetchError(error)}`, {
        action,
        cause: error,
        aborted: signal.aborted === true,
      });
    }
    const text = await response.text().catch(() => '');
    let payload;
    if (text.trim().length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new OneBotError(
          `${action} 返回了非 JSON 内容 (HTTP ${response.status})：${text.slice(0, 200)}`,
          { action, httpStatus: response.status },
        );
      }
    }
    if (!response.ok) {
      throw new OneBotError(`${action} 失败：HTTP ${response.status} ${payload?.message ?? payload?.wording ?? ''}`.trim(), {
        action,
        httpStatus: response.status,
        status: payload?.status,
        retcode: payload?.retcode,
      });
    }
    if (payload === undefined) return null;
    if (payload.status === 'failed' || (typeof payload.retcode === 'number' && payload.retcode !== 0)) {
      throw new OneBotError(
        `${action} 被 OneBot 拒绝：retcode=${payload.retcode} ${payload.message ?? ''} ${payload.wording ?? ''}`.trim(),
        { action, retcode: payload.retcode, status: payload.status },
      );
    }
    return payload.data ?? null;
  }

  /** Login identity of the connected QQ account. */
  getLoginInfo() {
    return this.call('get_login_info');
  }

  /** OneBot runtime status. */
  getStatus() {
    return this.call('get_status');
  }

  /** OneBot implementation name and version. */
  getVersionInfo() {
    return this.call('get_version_info');
  }

  /** Every group the account is in. */
  getGroupList() {
    return this.call('get_group_list');
  }

  /** Every friend of the account. */
  getFriendList() {
    return this.call('get_friend_list');
  }

  /** Members of one group. */
  getGroupMemberList(groupId) {
    return this.call('get_group_member_list', { group_id: Number(groupId) });
  }

  /** One group member's profile. */
  getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }

  /** One user's profile. */
  getStrangerInfo(userId) {
    return this.call('get_stranger_info', { user_id: Number(userId) });
  }

  /** Send a private message; returns the OneBot message id. */
  async sendPrivateMsg(userId, message) {
    const data = await this.call('send_private_msg', {
      user_id: Number(userId),
      message,
      auto_escape: false,
    });
    return data?.message_id ?? null;
  }

  /** Send a group message; returns the OneBot message id. */
  async sendGroupMsg(groupId, message) {
    const data = await this.call('send_group_msg', {
      group_id: Number(groupId),
      message,
      auto_escape: false,
    });
    return data?.message_id ?? null;
  }

  /** Fetch one message by id. */
  getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  /** Recall one message. */
  deleteMsg(messageId) {
    return this.call('delete_msg', { message_id: Number(messageId) });
  }

  /** Best-effort group history; not every implementation supports it. */
  getGroupMsgHistory(groupId, count = 20) {
    return this.call('get_group_msg_history', { group_id: Number(groupId), count });
  }

  /** Reachability probe that never throws. */
  async probe() {
    try {
      const info = await this.getLoginInfo();
      return {
        ok: true,
        userId: info?.user_id === undefined ? null : String(info.user_id),
        nickname: typeof info?.nickname === 'string' ? info.nickname : null,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Normalize a user-supplied API root. */
export function normalizeBaseUrl(value) {
  let url = String(value ?? '').trim();
  if (url.length === 0) url = 'http://127.0.0.1:3000';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

/** True for hosts that only accept loopback traffic. */
function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1';
}

/**
 * Loopback HTTP server receiving OneBot "HTTP POST report" events.
 *
 * Responds immediately with an empty quick-operation object so the OneBot side
 * never blocks on model work; the parsed event is dispatched asynchronously.
 */
export class EventServer {
  constructor(options) {
    this.host = options.host ?? '127.0.0.1';
    this.port = Number.isSafeInteger(options.port) ? options.port : 8799;
    this.path = normalizePath(options.path ?? '/onebot');
    this.secret = typeof options.secret === 'string' ? options.secret : '';
    this.maxBodyBytes = Number.isSafeInteger(options.maxBodyBytes) ? options.maxBodyBytes : 1024 * 1024;
    this.logger = options.logger;
    /** @type {(payload: any) => void} */
    this.onEvent = options.onEvent ?? (() => {});
    this.server = null;
    this.address = null;
    this.stats = { received: 0, rejected: 0, malformed: 0 };
  }

  /** The URL to paste into the OneBot client's report settings. */
  get reportUrl() {
    const host = this.host === '0.0.0.0' ? '127.0.0.1' : this.host;
    return `http://${host}:${this.port}${this.path}`;
  }

  /** Start listening; resolves with the bound address. */
  async start() {
    if (this.server !== null) return this.address;
    const server = http.createServer((request, response) => {
      this.#handle(request, response);
    });
    server.on('clientError', (_error, socket) => {
      socket.destroy();
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });
    this.server = server;
    const bound = server.address();
    this.address = typeof bound === 'object' && bound !== null
      ? { host: bound.address, port: bound.port, family: bound.family }
      : null;
    if (this.address !== null && this.address.port !== this.port) {
      this.logger?.info(`事件端口 ${this.port} 被占用，已改用 ${this.address.port}`);
      this.port = this.address.port;
    }
    if (!isLoopback(this.host)) {
      this.logger?.warn(`事件服务监听在 ${this.host}，非回环地址会接受任意网络上报；建议保持 127.0.0.1 并设置 reportSecret`);
    }
    return this.address;
  }

  /** Stop listening. Safe to call twice. */
  async stop() {
    const server = this.server;
    this.server = null;
    this.address = null;
    if (server === null) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 2000).unref?.();
    });
  }

  /** Verify the shared-secret signature or bearer token of a report. */
  #authorized(request, rawBody) {
    if (this.secret.length === 0) return true;
    const signature = request.headers['x-signature'];
    if (typeof signature === 'string' && signature.length > 0) {
      const provided = signature.startsWith('sha1=') ? signature.slice(5) : signature;
      const expected = createHmac('sha1', this.secret).update(rawBody).digest('hex');
      const a = Buffer.from(provided, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
    const authorization = request.headers.authorization;
    if (typeof authorization === 'string') {
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : authorization;
      if (token === this.secret) return true;
    }
    return false;
  }

  #handle(request, response) {
    const url = request.url ?? '/';
    const path = url.split('?')[0];
    if (path !== this.path) {
      if (request.method === 'GET' && (path === '/' || path === '/health')) {
        respondJson(response, 200, {
          ok: true,
          service: 'dsh-qq-bridge',
          reportPath: this.path,
          received: this.stats.received,
        });
        return;
      }
      respondJson(response, 404, { ok: false, error: 'not found' });
      return;
    }
    if (request.method === 'GET') {
      respondJson(response, 200, {
        ok: true,
        service: 'dsh-qq-bridge',
        hint: '把 OneBot 的 HTTP 上报地址设为这个 URL（POST）',
        received: this.stats.received,
      });
      return;
    }
    if (request.method !== 'POST') {
      respondJson(response, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    request.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > this.maxBodyBytes) {
        aborted = true;
        this.stats.rejected += 1;
        respondJson(response, 413, { ok: false, error: 'payload too large' });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks);
      if (!this.#authorized(request, raw)) {
        this.stats.rejected += 1;
        this.logger?.warn('收到未通过 secret 校验的上报，已丢弃');
        respondJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        this.stats.malformed += 1;
        respondJson(response, 400, { ok: false, error: 'invalid json' });
        return;
      }
      this.stats.received += 1;
      // Reply first: OneBot's quick-operation contract reads this body.
      respondJson(response, 200, {});
      try {
        void Promise.resolve(this.onEvent(payload)).catch((error) => {
          this.logger?.warn(`处理上报失败：${error instanceof Error ? error.message : String(error)}`);
        });
      } catch (error) {
        this.logger?.warn(`处理上报失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
    request.on('error', () => {
      // Client went away; nothing to answer.
    });
  }
}

/** Normalize a report path to a leading slash and no trailing slash. */
function normalizePath(value) {
  let path = String(value ?? '/onebot').trim();
  if (path.length === 0) path = '/onebot';
  if (!path.startsWith('/')) path = `/${path}`;
  return path.replace(/\/+$/, '') || '/onebot';
}

/** Send one JSON response. */
function respondJson(response, status, body) {
  if (response.writableEnded) return;
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

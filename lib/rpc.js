/**
 * Host half of the "QQ-bot" settings page.
 *
 * The Web client reaches this through the Connection RPC channel `/qq-bridge`:
 *
 *   connection.rpc.call('/qq-bridge', 'status', {})   -> { ok: true, value }
 *
 * Secrets never cross the wire: the page learns only whether a token or report
 * secret is set, never its value.
 *
 * Node builtins only — a profile-installed bundle cannot resolve `@deepseek-ai/*`.
 */

import { RUNTIME_OVERRIDE_KEYS } from './bridge.js';
import { GROUP_MODES } from './config.js';

/** Channel the client page calls. */
export const RPC_CHANNEL = '/qq-bridge';

const ok = (value) => ({ ok: true, value });
const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });

/** Everything the page renders, with secrets reduced to booleans. */
export function pageState(bridge) {
  const status = bridge.status();
  const config = bridge.config;
  return {
    ...status,
    config: {
      enabled: config.enabled,
      apiBaseUrl: config.apiBaseUrl,
      accessTokenSet: config.accessToken.length > 0,
      selfId: config.selfId,
      ownerIds: config.ownerIds.slice(),
      defaultGroupMode: config.defaultGroupMode,
      privateFromOthers: config.privateFromOthers,
      dryRun: config.dryRun,
      listenHost: config.listenHost,
      listenPort: config.listenPort,
      listenPath: config.listenPath,
      reportSecretSet: config.reportSecret.length > 0,
      debounceMs: config.debounceMs,
      maxTurnsPerHour: config.maxTurnsPerHour,
      groupToolAllow: config.groupSessions.toolAllow,
      remoteToolAllow: config.remote.toolAllow,
      dataDir: status.dataDir,
    },
  };
}

/** One RPC handler over the bridge's existing abilities. */
export function createRpcHandler(bridge) {
  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'status':
          return ok(pageState(bridge));

        case 'probe':
          await bridge.refreshIdentity();
          return ok(pageState(bridge));

        case 'setConfig': {
          const key = payload?.key;
          const value = payload?.value ?? null;
          if (typeof key !== 'string' || key.length === 0) return fail('bad-request', '缺少 key');
          if (!RUNTIME_OVERRIDE_KEYS.includes(key)) return fail('bad-request', `不允许在运行时修改 ${key}`);
          // An empty string means "drop the override and go back to the patch".
          const normalized = (typeof value === 'string' && value.trim().length === 0) ? null : value;
          await bridge.setOverride(key, normalized);
          return ok(pageState(bridge));
        }

        case 'owner': {
          const ownerId = String(payload?.ownerId ?? '').trim();
          if (!/^\d{5,12}$/.test(ownerId)) return fail('bad-request', 'QQ 号必须是 5~12 位数字');
          const remove = payload?.remove === true;
          const current = bridge.config.ownerIds.slice();
          const next = remove
            ? current.filter((id) => id !== ownerId)
            : (current.includes(ownerId) ? current : [...current, ownerId]);
          await bridge.setOverride('ownerIds', next);
          return ok(pageState(bridge));
        }

        case 'setGroupMode': {
          const groupId = String(payload?.groupId ?? '').trim();
          const mode = payload?.mode ?? null;
          if (groupId.length === 0) return fail('bad-request', '缺少 groupId');
          if (mode !== null && !GROUP_MODES.includes(mode)) return fail('bad-request', `不支持的群模式：${mode}`);
          bridge.setGroupMode(groupId, mode);
          return ok(pageState(bridge));
        }

        case 'setGroupPrompt': {
          const groupId = String(payload?.groupId ?? '').trim();
          if (groupId.length === 0) return fail('bad-request', '缺少 groupId');
          const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
          bridge.setGroupPrompt(groupId, prompt);
          return ok(pageState(bridge));
        }

        case 'sessions': {
          const limit = Number.isSafeInteger(payload?.limit) && payload.limit > 0 ? Math.min(payload.limit, 200) : 40;
          const sessions = await bridge.listSessions(limit);
          return ok({
            sessions,
            remoteSessionId: bridge.remoteSessionId(),
            remoteTarget: bridge.state.snapshot().remoteTarget,
          });
        }

        case 'setRemoteTarget': {
          const sessionId = String(payload?.sessionId ?? '').trim();
          if (sessionId.length === 0) return fail('bad-request', '缺少 sessionId');
          if (sessionId === 'off') {
            await bridge.clearRemoteTarget();
            return ok(pageState(bridge));
          }
          const sessions = await bridge.listSessions(200);
          const hit = sessions.find((session) => session.sessionId === sessionId);
          await bridge.setRemoteTarget(sessionId, hit === undefined ? sessionId : `${hit.title ?? sessionId}（${sessionId}）`);
          return ok(pageState(bridge));
        }

        case 'newRemoteSession': {
          const chat = bridge.remoteChat(bridge.config.ownerIds[0] ?? 'owner');
          await bridge.resetRemoteSession(chat);
          return ok(pageState(bridge));
        }

        case 'login': {
          return ok(await bridge.loginState());
        }

        case 'stickers': {
          const dir = bridge.stickerDirectory();
          if (!bridge.config.stickers.enabled) return ok({ enabled: false, dir, items: [] });
          const items = await bridge.listStickers();
          return ok({ enabled: true, dir, items });
        }

        default:
          return fail('not-found', `未知端点：${endpoint}`);
      }
    } catch (error) {
      return fail('internal', error instanceof Error ? error.message : String(error));
    }
  };
}

/**
 * Register the RPC channel on the Connection service when the profile has one.
 * @returns an async disposer that removes the channel again.
 */
/** Read a small JSON body from a raw Node request. */
function readJsonBody(request, maxBytes = 256 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(undefined);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return finish(undefined);
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(undefined);
      }
    });
    request.on('error', () => finish(undefined));
  });
}

/**
 * Fallback transport: our own prefix route at the same path.
 *
 * Only used when `connection.rpc.handle()` throws. It reuses the Connection
 * service's own admission check for authentication, so it is exactly as
 * protected as the RPC channel it replaces.
 */
function createPlainRoute(connection, handler, logger) {
  return {
    kind: 'prefix',
    path: RPC_CHANNEL,
    handler: async (request, response) => {
      try {
        if (typeof connection?.requestRejection === 'function') {
          const rejection = connection.requestRejection({ headers: request.headers });
          if (rejection !== undefined) {
            response.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('unauthorized');
            return;
          }
        } else {
          logger.warn('配置页兜底通道：拿不到 connection.requestRejection，拒绝服务以避免无鉴权暴露。');
          response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('no admission check available');
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('POST only');
          return;
        }
        const pathname = (request.url ?? '').split('?')[0];
        const endpoint = pathname.slice(RPC_CHANNEL.length + 1);
        const body = await readJsonBody(request);
        if (body === undefined || endpoint.length === 0) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ ok: false, error: { code: 'bad-request', message: 'bad body or endpoint', details: {} } }));
          return;
        }
        const result = await handler(endpoint, body.payload ?? {}, undefined, null);
        const text = JSON.stringify(result);
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(text),
        });
        response.end(text);
      } catch (error) {
        try {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          response.end(`route failure: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          // Response already gone.
        }
      }
    },
  };
}

/**
 * Register the RPC channel on the Connection service when the profile has one.
 *
 * `connection.rpc.handle()` mounts its HTTP route through the OWNER context
 * (`owner.effect(() => owner.webServer.register(route))`), so the context that
 * reads the service must also see `webServer` — otherwise the registration
 * throws inside the injection callback, where nothing of ours can catch it and
 * the page silently receives HTTP 405. Both services are therefore injected
 * together, every outcome is logged at `info`, and a self-registered route
 * takes over if the RPC channel cannot be mounted.
 *
 * @returns an async disposer that removes whichever transport was installed.
 */
export function registerRpc(ctx, bridge, logger) {
  let disposeChannel = null;
  let registered = false;
  const handler = createRpcHandler(bridge);

  const installFallback = (owner, connection, why) => {
    try {
      const webServer = typeof owner?.get === 'function' ? owner.get('webServer') : owner?.webServer;
      if (typeof webServer?.register !== 'function') {
        logger.warn(`配置页通道：兜底也无法安装（webServer 不可用）。原因：${why}`);
        return;
      }
      const disposer = webServer.register(createPlainRoute(connection, handler, logger));
      if (typeof disposer === 'function') disposeChannel = disposer;
      registered = true;
      logger.info(`配置页通道 ${RPC_CHANNEL} 已用兜底 HTTP 路由安装（原因：${why}）。`);
    } catch (error) {
      logger.warn(`配置页通道：兜底安装失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const attempt = (owner, how) => {
    if (registered) return;
    const read = (name) => {
      try {
        return typeof owner?.get === 'function' ? owner.get(name) : owner?.[name];
      } catch {
        return undefined;
      }
    };
    const connection = read('connection');
    const webServer = read('webServer');
    const hasHandle = typeof connection?.rpc?.handle === 'function';
    logger.info(`配置页通道检查（${how}）：connection=${connection ? '有' : '无'} webServer=${webServer ? '有' : '无'} rpc.handle=${hasHandle ? '有' : '无'}`);
    if (!hasHandle) {
      logger.warn('配置页通道：connection.rpc.handle 不可用，改用兜底路由。');
      installFallback(owner, connection, 'rpc.handle 不可用');
      return;
    }
    try {
      const disposer = connection.rpc.handle(RPC_CHANNEL, handler);
      if (typeof disposer === 'function') disposeChannel = disposer;
      registered = true;
      logger.info(`配置页通道 ${RPC_CHANNEL} 已注册（${how}）。`);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      logger.warn(`配置页通道注册失败（${how}）：${why}`);
      installFallback(owner, connection, why);
    }
  };

  // Preferred: wait until BOTH services are in scope, then register through that
  // context so `owner.webServer` resolves inside `handle`.
  const offBoth = ctx.inject(['connection', 'webServer'], (scoped) => {
    attempt(scoped, 'inject(connection+webServer)');
  });
  // Fallback: a profile with connection but no webServer still gets a log line
  // instead of silence.
  const offConnection = ctx.inject(['connection'], () => {
    if (!registered) attempt(ctx, 'inject(connection)+插件上下文');
  });

  return async () => {
    for (const off of [offBoth, offConnection]) {
      try {
        if (typeof off === 'function') off();
      } catch {
        // Best effort during teardown.
      }
    }
    if (disposeChannel !== null) {
      try {
        await disposeChannel();
      } catch {
        // Best effort during teardown.
      }
    }
  };
}

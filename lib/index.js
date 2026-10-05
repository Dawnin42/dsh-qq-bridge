/**
 * dsh-qq-bridge — a DSH Host plugin that connects a local OneBot v11 QQ client
 * to the Harness.
 *
 * What it does:
 *   - receives QQ group and private messages on a loopback HTTP endpoint;
 *   - gives every group (and, optionally, every stranger) its own DSH session,
 *     answering on @-mention or by following the conversation;
 *   - turns private messages from a marked owner account into DSH commands and
 *     relays the answer back to QQ;
 *   - exposes the whole thing to any agent through `qq_*` tools.
 *
 * Only Node builtins are imported: a profile-installed bundle cannot resolve
 * `@deepseek-ai/*` packages at runtime.
 */

import { QqBridge } from './bridge.js';
import { resolveConfig } from './config.js';
import { registerRpc } from './rpc.js';
import { registerTools } from './tools.js';

/** Services the plugin cannot work without. */
export const inject = ['tools'];

/** Cordis plugin entry. */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const logger = createLogger(ctx, config.logLevel);
  const bridge = new QqBridge({ ctx, config, logger });

  ctx.effect(() => {
    let startPromise = null;
    let disposed = false;

    const disposeTools = registerTools(ctx, bridge);
    // Backs the "QQ-bot" page in the Web settings panel. Never let a problem
    // here take the whole bridge down — QQ keeps working without the page.
    let disposeRpc = async () => {};
    try {
      disposeRpc = registerRpc(ctx, bridge, logger);
    } catch (error) {
      logger.warn(`注册配置页 RPC 通道失败（QQ 功能不受影响）：${error instanceof Error ? error.message : String(error)}`);
    }

    const offSessionEvent = ctx.on('session/event', (session, event) => {
      bridge.onSessionEvent(session, event);
    });
    const offAgentError = ctx.on('agent/error', (payload) => {
      bridge.onAgentError(payload?.agent, payload?.error);
    });
    const offAgentDisposed = ctx.on('agent/disposed', (payload) => {
      const chat = bridge.chatBySession(payload?.agent?.id);
      if (chat === undefined) return;
      chat.agent = null;
      chat.handle = null;
      chat.busy = false;
      chat.busySince = null;
    });

    startPromise = bridge.start().catch((error) => {
      logger.error(`启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    });

    return async () => {
      if (disposed) return;
      disposed = true;
      try {
        await startPromise;
      } catch {
        // Already reported.
      }
      offSessionEvent();
      offAgentError();
      offAgentDisposed();
      await bridge.stop();
      disposeTools();
      await disposeRpc();
    };
  });
}

/** Level-ordered, prefixing logger built on the Harness logger. */
function createLogger(ctx, level) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[level] ?? order.info;
  const emit = (method, message) => {
    if ((order[method] ?? order.info) < threshold) return;
    const line = `qq-bridge: ${message}`;
    try {
      const logger = ctx.logger;
      const target = typeof logger?.[method] === 'function' ? logger[method] : logger?.info;
      if (typeof target === 'function') {
        target.call(logger, line);
        return;
      }
    } catch {
      // Fall through to the console.
    }
    const fallback = method === 'debug' ? 'log' : method;
    if (typeof console[fallback] === 'function') console[fallback](line);
  };
  return {
    debug: (message) => emit('debug', message),
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  };
}

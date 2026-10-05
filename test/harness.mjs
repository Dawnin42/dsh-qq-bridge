/**
 * Test harness: a minimal stand-in for the Cordis host context.
 *
 * It models the three things the bridge touches — the tool registry (with a
 * separate global and agent-scoped view), the system-prompt registry, and the
 * agent registry — faithfully enough that routing, restriction, persona, and
 * reply-capture behaviour can be asserted without booting DSH.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { QqBridge } from '../lib/bridge.js';
import { resolveConfig } from '../lib/config.js';

/** Temp data directories created by {@link makeBridge}, removed by {@link cleanupAll}. */
const tempDirs = [];

/** Remove every temporary state directory this process created. */
export async function cleanupAll() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Logger that keeps messages for assertions instead of printing them. */
export function memoryLogger() {
  const lines = [];
  const push = (level) => (message) => { lines.push({ level, message: String(message) }); };
  return {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    text() { return lines.map((line) => `${line.level}: ${line.message}`).join('\n'); },
    has(fragment) { return lines.some((line) => line.message.includes(fragment)); },
  };
}

/** One fake agent, with just the surface the bridge uses. */
function makeAgent(id, ctx) {
  const received = [];
  return {
    id,
    ctx,
    received,
    status: 'idle',
    session: {
      id,
      header: { cwd: process.cwd() },
      requestHeader: () => undefined,
    },
    followup(message) {
      received.push(message);
      this.status = 'running';
    },
    steer() {},
    inject() {},
    cancel() {
      this.cancelled = true;
      this.status = 'idle';
    },
    async whenIdle() {},
  };
}

/** The fake host context. */
export function makeFakeCtx(services = {}) {
  const globalTools = new Map();
  const scopedTools = new Map();
  const restrictions = [];
  const sections = [];
  const listeners = new Map();

  const visibleSchemas = () => [...globalTools.values(), ...scopedTools.values()]
    .filter((definition) => {
      if (scopedTools.has(definition.name)) return true;
      const allowed = restrictions.length === 0
        ? null
        : restrictions[restrictions.length - 1].allow;
      return allowed === null || allowed === undefined || allowed.includes(definition.name);
    })
    .map(({ name, description, parameters }) => ({ name, description, parameters }));

  const toolsApi = {
    schemas: () => [...globalTools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
    register: (definition) => {
      globalTools.set(definition.name, definition);
      return () => globalTools.delete(definition.name);
    },
    restrict: (filter) => {
      restrictions.push(filter);
      return () => {};
    },
    /** Test helper: the agent-scoped view. */
    scopedSchemas: visibleSchemas,
  };

  const agentCtxFor = () => ({
    tools: {
      schemas: visibleSchemas,
      register: (definition) => {
        scopedTools.set(definition.name, definition);
        return () => scopedTools.delete(definition.name);
      },
      restrict: (filter) => {
        restrictions.push(filter);
        return () => {};
      },
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section);
        return () => {};
      },
    },
    on: () => () => {},
    effect: (callback) => callback(),
  });

  const ctx = {
    logger: memoryLogger(),
    tools: toolsApi,
    systemPrompt: {
      section: (section) => {
        sections.push(section);
        return () => {};
      },
    },
    get: (key) => services[key],
    /** Cordis' optional-dependency injection: skip the callback when a dep is absent. */
    inject: (deps, callback) => {
      const scoped = {};
      for (const dep of deps) {
        if (services[dep] === undefined) return () => {};
        scoped[dep] = services[dep];
      }
      const inner = callback(scoped);
      return () => {
        if (typeof inner === 'function') inner();
      };
    },
    on: (event, handler) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    effect: (callback) => callback(),
    /** Test helper: dispatch a host event to the fake listeners. */
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
    },
    /** Test helper: build a fresh agent-scoped context. */
    makeAgentCtx: agentCtxFor,
    /** Test helper: inspect registered/restricted/sectioned state. */
    _globalTools: globalTools,
    _scopedTools: scopedTools,
    _restrictions: restrictions,
    _sections: sections,
  };

  return ctx;
}

/** Fake `ctx.agents`. */
export class FakeAgents {
  constructor(ctx) {
    this.ctx = ctx;
    this.live = new Map();
    this.created = [];
    this.resumed = [];
    this.disposed = [];
  }

  get(id) {
    return this.live.get(id);
  }

  async create({ sessionId, meta, agentOptions, setup }) {
    const agentCtx = this.ctx.makeAgentCtx();
    const agent = makeAgent(sessionId, agentCtx);
    if (typeof setup === 'function') await setup(agentCtx, agent);
    this.live.set(sessionId, agent);
    this.created.push({ sessionId, meta, agentOptions, agent, agentCtx });
    return {
      agent,
      dispose: async () => {
        this.live.delete(sessionId);
        this.disposed.push(sessionId);
      },
    };
  }

  async resume({ resumeSessionId, setup, agentOptions }) {
    const agentCtx = this.ctx.makeAgentCtx();
    const agent = makeAgent(resumeSessionId, agentCtx);
    if (typeof setup === 'function') await setup(agentCtx, agent);
    this.live.set(resumeSessionId, agent);
    this.resumed.push({ sessionId: resumeSessionId, agentOptions, agent, agentCtx });
    return {
      agent,
      dispose: async () => {
        this.live.delete(resumeSessionId);
        this.disposed.push(resumeSessionId);
      },
    };
  }
}

/**
 * Build a bridge wired to a fake host context.
 *
 * @param {object} options
 * @param {object} [options.config] raw config overrides
 * @param {object} [options.services] extra host services
 */
export async function makeBridge(options = {}) {
  const ctx = makeFakeCtx(options.services ?? {});
  const agents = new FakeAgents(ctx);
  // Each bridge gets its own state directory: the real plugin persists group
  // modes to disk, so sharing one directory would leak between tests.
  const dataDir = options.dataDir ?? await mkdtemp(path.join(os.tmpdir(), 'qq-bridge-test-'));
  if (options.dataDir === undefined) tempDirs.push(dataDir);
  const config = resolveConfig({
    enabled: false,
    ownerIds: ['20001'],
    debounceMs: 40,
    mentionDebounceMs: 15,
    maxBufferMessages: 40,
    dataDir,
    ...options.config,
  });
  const logger = memoryLogger();
  const bridge = new QqBridge({ ctx, config, logger });
  bridge.logger = logger;
  // The agent registry is optional in the bridge, so it is supplied via ctx.get.
  ctx.get = (key) => (key === 'agents' ? agents : (options.services ?? {})[key]);
  await bridge.state.load();
  if (options.client !== undefined) bridge.client = options.client;
  bridge.startedAt = Date.now();
  return { bridge, ctx, agents, config, logger };
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `check` returns true, or fail after `timeoutMs`. */
export async function waitFor(check, timeoutMs = 2000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(intervalMs);
  }
}

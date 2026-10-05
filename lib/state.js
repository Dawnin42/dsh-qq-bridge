/**
 * Small JSON state file for everything the bridge learns at runtime: per-group
 * modes, counters, and the identity it discovered from OneBot.
 *
 * The file is written atomically (temp file + rename) and coalesced, so a burst
 * of group messages cannot corrupt or thrash it.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Fresh state document. */
function emptyState() {
  return {
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selfId: null,
    selfNickname: null,
    groupModes: {},
    // Every group the bot has ever seen: { id: { title, lastSeen } }. Kept so a
    // group's row (and its settings) survives a retired chat and a restart —
    // otherwise the page loses the row until the bot is @-ed again.
    groups: {},
    // Per-group persona overrides set at runtime; win over the bundle patch.
    groupPrompts: {},
    // Retired remote session id (set by `/reset`).
    remoteSessionId: null,
    // Where the owner's private messages are routed:
    // null = the dedicated session, otherwise { sessionId, label }.
    remoteTarget: null,
    // Runtime configuration set through the `qq_config` tool. These win over
    // the bundle patch and survive a restart, so the bridge can be pointed at
    // a new OneBot endpoint without editing YAML.
    overrides: {},
    stats: {
      eventsReceived: 0,
      groupMessages: 0,
      privateMessages: 0,
      turnsStarted: 0,
      repliesSent: 0,
      commandsRun: 0,
      lastEventAt: null,
      lastReplyAt: null,
      lastError: null,
    },
  };
}

/** Merge a loaded document onto the current shape so old files keep working. */
function normalizeState(raw) {
  const base = emptyState();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const groupModes = {};
  if (raw.groupModes !== null && typeof raw.groupModes === 'object' && !Array.isArray(raw.groupModes)) {
    for (const [key, value] of Object.entries(raw.groupModes)) {
      if (value === 'off' || value === 'mention' || value === 'auto') groupModes[String(key)] = value;
    }
  }
  const groupPrompts = {};
  if (raw.groupPrompts !== null && typeof raw.groupPrompts === 'object' && !Array.isArray(raw.groupPrompts)) {
    for (const [key, value] of Object.entries(raw.groupPrompts)) {
      if (typeof value === 'string' && value.trim().length > 0) groupPrompts[String(key)] = value.trim();
    }
  }
  const remoteTarget = (raw.remoteTarget !== null
    && typeof raw.remoteTarget === 'object'
    && !Array.isArray(raw.remoteTarget)
    && typeof raw.remoteTarget.sessionId === 'string'
    && raw.remoteTarget.sessionId.length > 0)
    ? {
      sessionId: raw.remoteTarget.sessionId,
      label: typeof raw.remoteTarget.label === 'string' ? raw.remoteTarget.label : raw.remoteTarget.sessionId,
    }
    : null;
  const groups = {};
  if (raw.groups !== null && typeof raw.groups === 'object' && !Array.isArray(raw.groups)) {
    for (const [key, value] of Object.entries(raw.groups)) {
      const id = String(key).trim();
      if (id.length === 0 || value === null || typeof value !== 'object') continue;
      groups[id] = {
        title: typeof value.title === 'string' && value.title.length > 0 ? value.title : null,
        lastSeen: Number.isSafeInteger(value.lastSeen) ? value.lastSeen : null,
      };
    }
  }
  return {
    ...base,
    createdAt: Number.isSafeInteger(raw.createdAt) ? raw.createdAt : base.createdAt,
    selfId: raw.selfId === undefined || raw.selfId === null ? null : String(raw.selfId),
    selfNickname: typeof raw.selfNickname === 'string' ? raw.selfNickname : null,
    groupModes,
    groups,
    groupPrompts,
    remoteSessionId: typeof raw.remoteSessionId === 'string' && raw.remoteSessionId.length > 0 ? raw.remoteSessionId : null,
    remoteTarget,
    overrides: (raw.overrides !== null && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides))
      ? { ...raw.overrides }
      : {},
    stats: { ...base.stats, ...(raw.stats !== null && typeof raw.stats === 'object' ? raw.stats : {}) },
  };
}

/** Default data directory: inside the DSH profile when there is one. */
export function resolveDataDir(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return path.resolve(configured.trim());
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (typeof profileDir === 'string' && profileDir.trim().length > 0) {
    return path.join(profileDir, '.qq-bridge');
  }
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'qq-bridge');
}

/** Coalescing, atomic JSON state store. */
export class StateStore {
  /**
   * @param {object} options
   * @param {string} options.dir directory holding `state.json`
   * @param {{warn: Function, info: Function, debug: Function}} options.logger
   */
  constructor(options) {
    this.dir = options.dir;
    this.file = path.join(options.dir, 'state.json');
    this.logger = options.logger;
    this.state = emptyState();
    this.loaded = false;
    this.dirty = false;
    this.timer = null;
    this.writing = null;
  }

  /** Read the state file, tolerating a missing or damaged one. */
  async load() {
    try {
      const text = await readFile(this.file, 'utf8');
      this.state = normalizeState(JSON.parse(text));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn(`状态文件读取失败，改为从空状态开始：${error instanceof Error ? error.message : String(error)}`);
      }
      this.state = emptyState();
    }
    this.loaded = true;
    return this.state;
  }

  /** Current document; mutate only through {@link mutate}. */
  snapshot() {
    return this.state;
  }

  /** Apply a synchronous mutation and schedule a durable write. */
  mutate(fn) {
    fn(this.state);
    this.state.updatedAt = Date.now();
    this.dirty = true;
    this.#schedule();
  }

  #schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 250);
    this.timer.unref?.();
  }

  /** Write now when dirty; concurrent callers share one write. */
  async flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.writing ?? undefined;
    this.dirty = false;
    this.writing = this.#write().finally(() => {
      this.writing = null;
    });
    return this.writing;
  }

  async #write() {
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      await rename(temp, this.file);
    } catch (error) {
      this.dirty = true;
      this.logger?.warn(`状态文件写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stop timers; the caller flushes first when it cares about durability. */
  dispose() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

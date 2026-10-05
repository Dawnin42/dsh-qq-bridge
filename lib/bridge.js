/**
 * The bridge: OneBot events in, DSH sessions out, QQ messages back.
 *
 * One `ChatRuntime` exists per QQ conversation the bridge participates in:
 *
 *   group:<groupId>      one DSH session per group, answered per its mode
 *   private:<userId>     a stranger's private chat (optional `chat` policy)
 *   remote:<ownerId>     the owner's private chat = the DSH command channel
 *
 * Group turns are debounced so a burst of chatter becomes one model turn, and
 * every chat has its own hourly turn budget.
 */

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { EventServer, OneBotClient } from './onebot.js';
import { resolveSticker, resolveStickerDir, listStickers } from './stickers.js';
import { StateStore, resolveDataDir } from './state.js';
import {
  buildTextMessage,
  mentionsSelf,
  normalizeSegments,
  segmentsToPlainText,
  senderName,
  stripSelfMentions,
} from './text.js';

/** Deep-freeze a message before it enters the DSH session log. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

/** Build one immutable user message exactly like the Harness' own helper. */
export function createUserMessage(text, source) {
  return deepFreeze({
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source,
  });
}

/** Text of one assistant content block list. */
function contentToText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** Expand `prefix*` patterns and exact names against the available tool names. */
export function expandToolAllowList(patterns, names) {
  const out = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      for (const name of names) {
        if (name.startsWith(prefix) && !out.includes(name)) out.push(name);
      }
    } else if (names.has(pattern) && !out.includes(pattern)) {
      out.push(pattern);
    }
  }
  return out;
}

/** Clock label for a message line. */
function clockLabel(time) {
  const date = new Date(typeof time === 'number' && time > 0 ? time * 1000 : Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Config keys the `qq_config` tool may override at runtime. */
export const RUNTIME_OVERRIDE_KEYS = [
  'apiBaseUrl',
  'accessToken',
  'ownerIds',
  'defaultGroupMode',
  'dryRun',
  'privateFromOthers',
  'selfId',
  // A busy `auto` group can burn the hourly budget fast; hitting it makes the
  // bot go quiet with no warning, so this must be tunable without a restart.
  'maxTurnsPerHour',
];

/** Upper bound accepted for `maxTurnsPerHour` (guards a runaway model bill). */
export const MAX_TURNS_LIMIT = 2000;

/** One conversation the bridge participates in. */
class ChatRuntime {
  constructor(fields) {
    this.key = fields.key;
    this.kind = fields.kind;
    this.chatId = fields.chatId;
    this.title = fields.title;
    this.sessionId = fields.sessionId;
    this.mode = fields.mode ?? 'off';
    this.buffer = [];
    this.pending = [];
    this.timer = null;
    this.agent = null;
    this.handle = null;
    this.creating = null;
    this.busy = false;
    this.busySince = null;
    this.turnTexts = [];
    this.sentThisTurn = new Set();
    this.agentRepliedThisTurn = false;
    this.relayAnswer = false;
    this.turnCount = 0;
    this.hourStart = Date.now();
    this.lastTurnAt = null;
    this.lastError = null;
  }
}

export class QqBridge {
  /**
   * @param {object} options
   * @param {any} options.ctx Cordis host context owning this plugin.
   * @param {any} options.config Normalized config from `resolveConfig`.
   * @param {{info: Function, warn: Function, error: Function, debug?: Function}} options.logger
   */
  constructor(options) {
    this.ctx = options.ctx;
    // `patchConfig` is what the bundle patch asked for; `config` is what is
    // actually in force, after persisted runtime overrides.
    this.patchConfig = options.config;
    this.config = options.config;
    this.logger = options.logger;
    this.state = new StateStore({ dir: resolveDataDir(this.config.dataDir), logger: options.logger });
    this.client = new OneBotClient({
      baseUrl: this.config.apiBaseUrl,
      accessToken: this.config.accessToken,
      timeoutMs: this.config.requestTimeoutMs,
      logger: options.logger,
    });
    this.server = new EventServer({
      host: this.config.listenHost,
      port: this.config.listenPort,
      path: this.config.listenPath,
      secret: this.config.reportSecret,
      logger: options.logger,
      onEvent: (payload) => this.handleEvent(payload),
    });
    /** @type {Map<string, ChatRuntime>} */
    this.chats = new Map();
    /** @type {Map<string, string>} */
    this.groupNames = new Map();
    this.selfId = this.config.selfId;
    this.selfNickname = null;
    this.connected = false;
    this.lastProbe = null;
    this.startedAt = null;
    this.stopped = false;
    this.child = null;
    this.cachedCwd = null;
    this.recentReplies = [];
    this.groupNamesFetchedAt = 0;
    this.stickerDir = null;
  }

  /** Absolute sticker folder, created on first use. */
  stickerDirectory() {
    if (this.stickerDir === null) {
      this.stickerDir = resolveStickerDir(this.config.stickers.dir, this.state.dir);
    }
    return this.stickerDir;
  }

  /** Names available in the sticker folder. */
  listStickers() {
    return listStickers(this.stickerDirectory());
  }

  /** Turn one sticker spec into OneBot segments, or an error string. */
  resolveSticker(spec) {
    return resolveSticker(spec, {
      dir: this.stickerDirectory(),
      maxBytes: this.config.stickers.maxBytes,
    });
  }

  // ---------------------------------------------------------------- lifecycle

  /** Load state, start the event server, and probe OneBot. */
  async start() {
    this.startedAt = Date.now();
    await this.state.load();
    this.config = this.applyOverrides(this.patchConfig);
    this.syncTransport();
    const persisted = this.state.snapshot();
    if (this.selfId === null && persisted.selfId !== null) this.selfId = persisted.selfId;
    if (persisted.selfNickname !== null) this.selfNickname = persisted.selfNickname;
    if (!this.config.enabled) {
      this.logger.info('QQ 桥已加载但未启用（enabled: false）；只注册工具与状态，不连接 QQ。');
      return { enabled: false };
    }
    if (this.config.ownerIds.length === 0) {
      this.logger.warn('还没有配置主人 QQ（ownerIds），私信遥控通道是关闭的。把 QQ 号写进 ownerIds，或让 DSH 调用 qq_config 设置。');
    }
    try {
      await this.server.start();
      this.logger.info(`QQ 桥事件服务已监听 ${this.server.reportUrl} —— 把它填进 OneBot 客户端的「HTTP 上报」地址`);
    } catch (error) {
      this.logger.error(`事件服务启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.config.client.enabled) await this.launchClient();
    await this.refreshIdentity();
    this.logger.info(`群聊默认模式 ${this.config.defaultGroupMode}；主人 QQ ${this.config.ownerIds.join(', ') || '（未配置，遥控通道关闭）'}；dryRun=${this.config.dryRun}`);
    return { enabled: true, reportUrl: this.server.reportUrl };
  }

  /** Stop timers, the HTTP server, and every DSH session this plugin owns. */
  async stop() {
    this.stopped = true;
    for (const chat of this.chats.values()) {
      if (chat.timer !== null) {
        clearTimeout(chat.timer);
        chat.timer = null;
      }
    }
    for (const chat of this.chats.values()) {
      const handle = chat.handle;
      chat.handle = null;
      chat.agent = null;
      if (handle !== null) {
        try {
          await handle.dispose();
        } catch (error) {
          this.logger.warn(`释放会话 ${chat.sessionId} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    this.chats.clear();
    await this.state.flush();
    this.state.dispose();
    await this.server.stop();
  }

  /** Apply a live config patch (used by reload). */
  applyConfig(next) {
    const previous = this.patchConfig;
    this.patchConfig = next;
    this.config = this.applyOverrides(next);
    this.syncTransport();
    if (next.selfId !== null) this.selfId = next.selfId;
    if (previous.dataDir !== next.dataDir) this.logger.warn('dataDir 变更需要重启 DSH 才会生效。');
  }

  /** Push the effective endpoint settings into the live client and server. */
  syncTransport() {
    this.client.configure({
      baseUrl: this.config.apiBaseUrl,
      accessToken: this.config.accessToken,
      timeoutMs: this.config.requestTimeoutMs,
    });
    this.server.host = this.config.listenHost;
    this.server.port = this.config.listenPort;
    this.server.path = this.config.listenPath.startsWith('/') ? this.config.listenPath : `/${this.config.listenPath}`;
    this.server.secret = this.config.reportSecret;
  }

  // ------------------------------------------------------- runtime overrides

  /** Merge persisted runtime overrides onto a base config. */
  applyOverrides(base) {
    const overrides = this.state.snapshot().overrides ?? {};
    const next = { ...base };
    for (const key of RUNTIME_OVERRIDE_KEYS) {
      if (overrides[key] === undefined || overrides[key] === null) continue;
      if (key === 'maxTurnsPerHour') {
        // Stored as JSON, could be a string from an older file — coerce, and
        // ignore anything nonsensical rather than silently breaking the budget.
        const value = Number(overrides[key]);
        if (Number.isSafeInteger(value) && value > 0 && value <= MAX_TURNS_LIMIT) next[key] = value;
        continue;
      }
      next[key] = overrides[key];
    }
    return next;
  }

  /** Persist one runtime override and apply it immediately. */
  async setOverride(key, value) {
    if (!RUNTIME_OVERRIDE_KEYS.includes(key)) throw new Error(`不支持在运行时修改 ${key}`);
    if (value !== null && key === 'maxTurnsPerHour') {
      const turns = Number(value);
      if (!Number.isSafeInteger(turns) || turns <= 0 || turns > MAX_TURNS_LIMIT) {
        throw new Error(`每小时轮次上限必须是 1~${MAX_TURNS_LIMIT} 的整数`);
      }
      value = turns;
    }
    if (value === null) {
      this.state.mutate((state) => {
        const next = { ...(state.overrides ?? {}) };
        delete next[key];
        state.overrides = next;
      });
    } else {
      this.state.mutate((state) => {
        state.overrides = { ...(state.overrides ?? {}), [key]: value };
      });
    }
    this.config = this.applyOverrides(this.patchConfig);
    this.syncTransport();
    if (key === 'selfId') this.selfId = this.config.selfId;
    await this.state.flush();
    return this.config[key];
  }

  /** The overrides currently persisted, for reporting. */
  overrides() {
    return { ...(this.state.snapshot().overrides ?? {}) };
  }

  // ---------------------------------------------------------------- transport

  /** Ask OneBot who we are. Never throws. */
  async refreshIdentity() {
    const probe = await this.client.probe();
    this.lastProbe = { ...probe, at: Date.now() };
    if (!probe.ok) {
      this.connected = false;
      this.logger.warn(`OneBot 未就绪：${probe.error}（收到上报或调用工具时会自动重试）`);
      return probe;
    }
    this.connected = true;
    if (probe.userId !== null) {
      if (this.config.selfId === null) this.selfId = probe.userId;
      this.selfNickname = probe.nickname;
      this.state.mutate((state) => {
        state.selfId = probe.userId;
        state.selfNickname = probe.nickname;
      });
    }
    this.logger.info(`已连接 QQ ${probe.nickname ?? ''}(${probe.userId ?? '?'})`);
    void this.refreshGroupNames();
    return probe;
  }

  /** Cache group names so session titles read nicely. */
  async refreshGroupNames() {
    if (Date.now() - this.groupNamesFetchedAt < 60_000) return;
    this.groupNamesFetchedAt = Date.now();
    try {
      const list = await this.client.getGroupList();
      if (!Array.isArray(list)) return;
      for (const group of list) {
        if (group?.group_id === undefined) continue;
        const name = typeof group.group_name === 'string' ? group.group_name : null;
        if (name !== null) this.groupNames.set(String(group.group_id), name);
      }
    } catch (error) {
      this.logger.debug?.(`读取群列表失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Start the configured local OneBot client, if any. */
  async launchClient() {
    const { command, args, cwd } = this.config.client;
    if (command === null) {
      this.logger.warn('client.enabled 为 true，但 client.command 为空，未启动任何程序。');
      return { ok: false, error: 'client.command 未配置' };
    }
    if (this.child !== null) return { ok: true, alreadyRunning: true, pid: this.child.pid ?? null };
    try {
      const { spawn } = await import('node:child_process');
      const child = spawn(command, args, {
        cwd: cwd ?? process.cwd(),
        detached: false,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.on('exit', (code) => {
        this.logger.info(`OneBot 客户端进程退出（code=${code}）。`);
        this.child = null;
      });
      child.on('error', (error) => {
        this.logger.warn(`OneBot 客户端启动失败：${error.message}`);
        this.child = null;
      });
      this.child = child;
      this.logger.info(`已启动 OneBot 客户端：${command} (pid=${child.pid ?? '?'})`);
      return { ok: true, pid: child.pid ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OneBot 客户端启动失败：${message}`);
      return { ok: false, error: message };
    }
  }

  /** Stop the process started by {@link launchClient}. */
  stopClient() {
    if (this.child === null) return { ok: true, stopped: false };
    try {
      this.child.kill();
    } catch {
      // The process may already be gone.
    }
    this.child = null;
    return { ok: true, stopped: true };
  }

  // ------------------------------------------------------------------- events

  /** Entry point for every OneBot report. */
  async handleEvent(payload) {
    if (payload === null || typeof payload !== 'object') return;
    if (!this.config.enabled) return;
    this.state.mutate((state) => {
      state.stats.eventsReceived += 1;
      state.stats.lastEventAt = Date.now();
    });
    switch (payload.post_type) {
      case 'message':
        this.connected = true;
        if (payload.message_type === 'group') this.onGroupMessage(payload);
        else if (payload.message_type === 'private') this.onPrivateMessage(payload);
        return;
      case 'meta_event':
        this.connected = true;
        if (payload.meta_event_type === 'lifecycle') {
          this.logger.info(`OneBot 生命周期事件：${payload.sub_type}`);
          void this.refreshIdentity();
        }
        if (payload.meta_event_type === 'heartbeat' && payload.status?.online === false) this.connected = false;
        return;
      case 'notice':
        this.logger.debug?.(`notice: ${payload.notice_type}`);
        return;
      default:
        return;
    }
  }

  /** A group message arrived. */
  onGroupMessage(payload) {
    const groupId = String(payload.group_id ?? '');
    const userId = String(payload.user_id ?? '');
    if (groupId.length === 0 || userId.length === 0) return;
    if (this.selfId !== null && userId === this.selfId) return;
    const segments = normalizeSegments(payload.message);
    const mentioned = mentionsSelf(segments, this.selfId);
    const record = {
      time: Number(payload.time) || Math.floor(Date.now() / 1000),
      userId,
      name: senderName(payload.sender, userId),
      text: segmentsToPlainText(mentioned ? stripSelfMentions(segments, this.selfId) : segments).trim(),
      mentioned,
      self: false,
      messageId: payload.message_id ?? null,
    };
    const chat = this.chatFor(`group:${groupId}`, () => new ChatRuntime({
      key: `group:${groupId}`,
      kind: 'group',
      chatId: groupId,
      title: `${this.config.groupSessions.titlePrefix}${this.groupNames.get(groupId) ?? groupId}`,
      sessionId: `${this.config.groupSessions.sessionPrefix}${groupId}`,
      mode: this.modeFor(groupId),
    }));
    this.state.mutate((state) => { state.stats.groupMessages += 1; });
    this.noteGroup(groupId, chat.title);
    this.record(chat, record);

    if (chat.mode === 'off' || !this.groupAllowed(groupId)) return;
    if (chat.mode === 'mention' && !mentioned && chat.pending.length === 0) return;
    if (chat.mode === 'auto' && record.text.length === 0) return;
    chat.pending.push(record);
    this.schedule(chat, chat.mode === 'mention' ? this.config.mentionDebounceMs : this.config.debounceMs);
  }

  /** A private message arrived: owner command channel, or an ordinary chat. */
  onPrivateMessage(payload) {
    const userId = String(payload.user_id ?? '');
    if (userId.length === 0) return;
    if (this.selfId !== null && userId === this.selfId) return;
    const segments = normalizeSegments(payload.message);
    const text = segmentsToPlainText(segments).trim();
    const record = {
      time: Number(payload.time) || Math.floor(Date.now() / 1000),
      userId,
      name: senderName(payload.sender, userId),
      text,
      mentioned: true,
      self: false,
      messageId: payload.message_id ?? null,
    };
    this.state.mutate((state) => { state.stats.privateMessages += 1; });

    if (this.isOwner(userId)) {
      if (!this.config.remote.enabled) return;
      const chat = this.remoteChat(userId);
      this.record(chat, record);
      if (text.length === 0) {
        void this.sendPrivate(userId, '（这条私信里没有文字，我看不到图片和语音的内容）').catch(() => {});
        return;
      }
      if (this.handleOwnerCommand(chat, text)) return;
      chat.pending.push(record);
      void this.flush(chat, 'remote');
      return;
    }

    if (this.config.privateFromOthers !== 'chat') {
      this.logger.debug?.(`忽略非主人私信：${userId}`);
      return;
    }
    const chat = this.chatFor(`private:${userId}`, () => new ChatRuntime({
      key: `private:${userId}`,
      kind: 'private',
      chatId: userId,
      title: `${this.config.privateChat.titlePrefix}${record.name}`,
      sessionId: `${this.config.privateChat.sessionPrefix}${userId}`,
      mode: 'mention',
    }));
    this.record(chat, record);
    chat.pending.push(record);
    this.schedule(chat, this.config.mentionDebounceMs);
  }

  // -------------------------------------------------------------------- chats

  /** Get or create the runtime for one chat key. */
  chatFor(key, create) {
    let chat = this.chats.get(key);
    if (chat === undefined) {
      chat = create();
      this.chats.set(key, chat);
    }
    return chat;
  }

  /**
   * Where the owner's private messages go.
   *
   * Preference order: an explicitly routed session, then a session retired by
   * `/reset`, then the plugin's own dedicated session. Routing to a real
   * session means the command lands in the conversation the owner is actually
   * working in, instead of a bridge-owned one.
   */
  remoteSessionId() {
    const state = this.state.snapshot();
    const target = state.remoteTarget;
    if (target !== null && typeof target.sessionId === 'string' && target.sessionId.length > 0) return target.sessionId;
    if (typeof state.remoteSessionId === 'string' && state.remoteSessionId.length > 0) return state.remoteSessionId;
    return this.config.remote.sessionId;
  }

  /** Route the owner's commands into an existing (or brand-new) session. */
  async setRemoteTarget(sessionId, label) {
    const id = String(sessionId ?? '').trim();
    if (id.length === 0) throw new Error('缺少 sessionId');
    // Drop the old runtime so the next message builds one for the new target.
    this.#retireRemoteChat();
    this.state.mutate((state) => {
      state.remoteTarget = { sessionId: id, label: typeof label === 'string' && label.length > 0 ? label : id };
    });
    await this.state.flush();
    return this.state.snapshot().remoteTarget;
  }

  /** Go back to the plugin's own dedicated remote session. */
  async clearRemoteTarget() {
    this.#retireRemoteChat();
    this.state.mutate((state) => { state.remoteTarget = null; });
    await this.state.flush();
    return this.remoteSessionId();
  }

  /** Drop the current remote ChatRuntime without touching the session itself. */
  #retireRemoteChat() {
    for (const [key, chat] of [...this.chats.entries()]) {
      if (chat.kind !== 'remote') continue;
      if (chat.timer !== null) clearTimeout(chat.timer);
      this.chats.delete(key);
    }
  }

  /** The owner's remote-control chat. */
  remoteChat(ownerId) {
    return this.chatFor(`remote:${ownerId}`, () => new ChatRuntime({
      key: `remote:${ownerId}`,
      kind: 'remote',
      chatId: ownerId,
      title: typeof this.state.snapshot().remoteTarget?.label === 'string'
        ? this.state.snapshot().remoteTarget.label
        : this.config.remote.title,
      sessionId: this.remoteSessionId(),
      mode: 'mention',
    }));
  }

  /**
   * Recent sessions the owner could route commands into, newest first.
   * Never throws: routing is a convenience, not a dependency.
   */
  async listSessions(limit = 40) {
    const query = this.ctx.get('sessionQuery');
    if (query === undefined || typeof query.listSessions !== 'function') return [];
    let records;
    try {
      records = await query.listSessions();
    } catch {
      return [];
    }
    if (!Array.isArray(records)) return [];
    const capped = records.slice(0, Math.max(1, Math.min(limit, 200)));
    let titles = new Map();
    try {
      if (typeof query.readTitleSnapshots === 'function') {
        const snapshots = await query.readTitleSnapshots(capped.map((record) => record.header.id));
        for (const entry of snapshots) {
          if (entry.status === 'fulfilled' && entry.value?.title?.title) {
            titles.set(String(entry.sessionId), entry.value.title.title);
          }
        }
      }
    } catch {
      titles = new Map();
    }
    return capped.map((record) => ({
      sessionId: String(record.header.id),
      title: titles.get(String(record.header.id)) ?? null,
      cwd: typeof record.header.cwd === 'string' ? record.header.cwd : null,
      createdAt: typeof record.header.createdAt === 'number' ? record.header.createdAt : null,
      live: record.live === true,
      persisted: record.persisted === true,
    }));
  }

  /** True when this QQ number may drive DSH. */
  isOwner(userId) {
    return this.config.ownerIds.includes(String(userId));
  }

  /** Effective answering mode for one group. */
  modeFor(groupId) {
    const id = String(groupId);
    const runtime = this.state.snapshot().groupModes[id];
    if (runtime === 'off' || runtime === 'mention' || runtime === 'auto') return runtime;
    const configured = this.config.groups[id];
    if (configured !== undefined) return configured;
    return this.config.defaultGroupMode;
  }

  /** Persist a group mode (null clears the runtime override). */
  setGroupMode(groupId, mode) {
    const id = String(groupId);
    if (mode === null) {
      this.state.mutate((state) => { delete state.groupModes[id]; });
      this.#persistNow();
      return this.modeFor(id);
    }
    this.state.mutate((state) => { state.groupModes[id] = mode; });
    this.#persistNow();
    const chat = this.chats.get(`group:${id}`);
    if (chat !== undefined) {
      chat.mode = mode;
      if (mode === 'off') {
        chat.pending = [];
        if (chat.timer !== null) {
          clearTimeout(chat.timer);
          chat.timer = null;
        }
      }
    }
    return mode;
  }

  /**
   * Make the last mutation durable right away.
   *
   * `state.mutate()` only schedules a debounced write, so an edit made moments
   * before DSH restarts used to be lost silently — observed twice while testing
   * (a cleared group prompt came back after the next restart).
   */
  #persistNow() {
    void this.state.flush().catch((error) => {
      this.logger.warn(`状态落盘失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Remember a group the bot has seen.
   *
   * The group list must NOT be derived from live chats: retiring a chat (a
   * prompt edit does that) or restarting DSH would drop the row, and the group
   * would only come back after a fresh @-mention. This registry is durable and
   * keeps each group's row — and therefore its settings — in place.
   */
  noteGroup(groupId, title) {
    const id = String(groupId);
    if (id.length === 0) return;
    const label = typeof title === 'string' && title.length > 0 ? title : null;
    const current = this.state.snapshot().groups[id];
    if (current !== undefined && current.title === label && current.lastSeen !== null && Date.now() - current.lastSeen < 60_000) return;
    this.state.mutate((state) => { state.groups[id] = { title: label, lastSeen: Date.now() }; });
  }

  /**
   * Drop a chat's live agent so the next message rebuilds it from scratch.
   *
   * The session itself is untouched — it stays on disk and is resumed on the
   * next message; only the in-memory handle goes away. Per-agent setup (persona,
   * tools) then runs again against fresh config.
   */
  async retireChat(key) {
    const chat = this.chats.get(key);
    if (chat === undefined) return false;
    const handle = chat.handle;
    chat.handle = null;
    chat.agent = null;
    chat.creating = null;
    chat.busy = false;
    chat.busySince = null;
    chat.pending = [];
    chat.turnTexts = [];
    chat.sentThisTurn = new Set();
    this.chats.delete(key);
    if (handle !== null && handle !== undefined) {
      try {
        await handle.dispose();
      } catch (error) {
        this.logger.warn(`淘汰会话 ${chat.sessionId} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return true;
  }

  /**
   * Login state for the settings page.
   *
   * The OneBot client runs with its window hidden, so the login QR it would
   * otherwise only show in a console has to reach the browser instead.
   */
  async loginState() {
    const probe = await this.refreshIdentity();
    if (probe.ok === true) {
      return {
        state: 'online',
        userId: probe.userId ?? this.selfId,
        nickname: probe.nickname ?? this.selfNickname,
        apiBaseUrl: this.client.baseUrl,
      };
    }
    const qrcodePath = this.config.login.qrcodePath;
    let qrcode = null;
    let modifiedAt = null;
    let error = null;
    try {
      const info = await stat(qrcodePath);
      if (info.isFile()) {
        const bytes = await readFile(qrcodePath);
        qrcode = `data:image/png;base64,${bytes.toString('base64')}`;
        modifiedAt = info.mtimeMs;
      } else {
        error = `${qrcodePath} 不是一个文件`;
      }
    } catch (cause) {
      error = `读不到二维码文件 ${qrcodePath}：${cause instanceof Error ? cause.message : String(cause)}`;
    }
    return {
      state: 'offline',
      apiBaseUrl: this.client.baseUrl,
      probeError: probe.error ?? null,
      qrcodePath,
      qrcode,
      modifiedAt,
      error,
    };
  }

  /** Effective persona override for one group (runtime wins over the patch). */
  groupPrompt(groupId) {
    const id = String(groupId);
    const runtime = this.state.snapshot().groupPrompts[id];
    if (typeof runtime === 'string' && runtime.trim().length > 0) return runtime.trim();
    const configured = this.config.groupPrompts[id];
    return typeof configured === 'string' ? configured : '';
  }

  /** Set or clear one group's persona override. */
  setGroupPrompt(groupId, prompt) {
    const id = String(groupId);
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    const before = this.groupPrompt(id);
    if (text.length === 0) {
      this.state.mutate((state) => { delete state.groupPrompts[id]; });
    } else {
      this.state.mutate((state) => { state.groupPrompts[id] = text; });
    }
    this.#persistNow();
    // Rebuild the group's agent so the change applies to the very next message,
    // instead of whenever the session happens to be recreated. A busy chat is
    // retired when its current turn ends, so nothing is cut off mid-answer.
    if (this.groupPrompt(id) !== before) {
      const chat = this.chats.get(`group:${id}`);
      if (chat !== undefined && (chat.busy || chat.pending.length > 0)) {
        chat.retireAfterTurn = true;
        this.logger.info(`群 ${id} 的提示词已更新，这一轮结束后重建它的会话以生效。`);
      } else {
        void this.retireChat(`group:${id}`);
      }
    }
    return this.groupPrompt(id);
  }

  /** Whether the group passes allow/deny filters. */
  groupAllowed(groupId) {
    const id = String(groupId);
    if (this.config.denyGroups.includes(id)) return false;
    if (this.config.allowGroups.length > 0 && !this.config.allowGroups.includes(id)) return false;
    return true;
  }

  /** Push one message into the chat ring buffer. */
  record(chat, entry) {
    chat.buffer.push(entry);
    const limit = this.config.maxBufferMessages;
    if (chat.buffer.length > limit) chat.buffer.splice(0, chat.buffer.length - limit);
  }

  /** (Re)arm the debounce timer of one chat. */
  schedule(chat, delayMs) {
    if (this.stopped) return;
    if (chat.timer !== null) clearTimeout(chat.timer);
    chat.timer = setTimeout(() => {
      chat.timer = null;
      void this.flush(chat, 'debounce');
    }, Math.max(50, delayMs));
    chat.timer.unref?.();
  }

  /** Turn the pending batch of one chat into one DSH turn. */
  async flush(chat, reason) {
    if (this.stopped || chat.pending.length === 0) return;
    if (chat.busy) {
      const since = chat.busySince;
      if (since !== null && Date.now() - since > this.config.busyTimeoutMs) {
        this.logger.warn(`${chat.title} 的上一轮超过 ${Math.round(this.config.busyTimeoutMs / 1000)} 秒没有结束，判定为卡住并继续处理新消息。`);
        chat.busy = false;
        chat.busySince = null;
      } else {
        this.schedule(chat, 1500);
        return;
      }
    }
    if (!this.takeTurnBudget(chat)) {
      this.logger.warn(`${chat.title} 已达每小时 ${this.config.maxTurnsPerHour} 轮的预算，本轮跳过。`);
      chat.pending = [];
      return;
    }
    const batch = chat.pending;
    chat.pending = [];
    const agent = await this.ensureAgent(chat);
    if (agent === null) {
      this.logger.warn(`${chat.title} 的 DSH 会话准备失败，${batch.length} 条消息被丢弃。`);
      return;
    }
    if (this.stopped) return;
    const text = this.renderTurn(chat, batch, reason);
    chat.busy = true;
    chat.busySince = Date.now();
    chat.turnTexts = [];
    chat.sentThisTurn = new Set();
    chat.agentRepliedThisTurn = false;
    // A direct address (an @-mention, a private chat, the owner's command
    // channel) must produce an answer even when the model forgets the tool.
    // Automatic group participation stays opt-in through qq_reply, so a
    // followed conversation never turns into spam.
    chat.relayAnswer = chat.kind !== 'group'
      || reason === 'mention'
      || batch.some((entry) => entry.mentioned === true);
    chat.lastTurnAt = Date.now();
    this.state.mutate((state) => { state.stats.turnsStarted += 1; });
    try {
      agent.followup(createUserMessage(text, {
        kind: 'qq-bridge',
        chat: chat.key,
        chatKind: chat.kind,
        reason,
      }));
    } catch (error) {
      chat.busy = false;
      chat.busySince = null;
      this.fail(`向 ${chat.title} 投递消息失败`, error);
      return;
    }
    this.logger.info(`→ ${chat.title}：${batch.length} 条消息进入 DSH 会话 ${chat.sessionId}（${reason}）`);
    if (chat.kind === 'remote' && this.config.remote.ack) {
      void this.sendPrivate(chat.chatId, '收到，正在处理…').catch(() => {});
    }
  }

  /** Rolling-hour turn budget. */
  takeTurnBudget(chat) {
    const now = Date.now();
    if (now - chat.hourStart >= 3_600_000) {
      chat.hourStart = now;
      chat.turnCount = 0;
    }
    if (chat.turnCount >= this.config.maxTurnsPerHour) return false;
    chat.turnCount += 1;
    return true;
  }

  /** Render one turn of QQ traffic into the text the model reads. */
  renderTurn(chat, batch, reason) {
    const first = batch[0];
    const firstIndex = chat.buffer.indexOf(first);
    const context = firstIndex > 0
      ? chat.buffer.slice(0, firstIndex).slice(-this.config.contextMessages)
      : [];
    const lines = [];
    const rendered = (entry) => `  ${clockLabel(entry.time)} ${entry.name}(${entry.userId})：${entry.text || '（无文字内容）'}`;

    if (context.length > 0) {
      lines.push('【稍早的对话】');
      for (const entry of context) lines.push(rendered(entry));
      lines.push('');
    }
    if (chat.kind === 'group') {
      lines.push(`【QQ 群消息】${chat.title}（群号 ${chat.chatId}）`);
    } else if (chat.kind === 'remote') {
      lines.push(`【来自主人的 QQ 私信指令】${first.name}(${first.userId})`);
    } else {
      lines.push(`【QQ 私信】${first.name}(${first.userId})`);
    }
    lines.push(`【本轮新消息】共 ${batch.length} 条`);
    for (const entry of batch) lines.push(rendered(entry));
    lines.push('');
    if (chat.kind === 'group') {
      lines.push('回复方式：调用 qq_reply 工具，内容才会发到群里。不想说话就不要调用它——保持沉默是正确的选择。');
      lines.push(`（触发原因：${reason === 'mention' ? '有人 @ 了你' : '自动跟聊'}）`);
    } else if (chat.kind === 'private') {
      lines.push('回复方式：调用 qq_reply 工具，内容才会发出去。不想回复就不要调用它。');
    } else {
      lines.push('你回复的文字会自动发回主人的 QQ，直接写结论即可。');
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ sessions

  /** The agent registry, when this profile has one. */
  agents() {
    return this.ctx.get('agents');
  }

  /** Live agent for one chat, created or resumed on demand. */
  async ensureAgent(chat) {
    const agents = this.agents();
    if (agents === undefined) {
      this.logger.warn('当前 profile 没有 agents 服务，无法为 QQ 会话建立 DSH 会话。');
      return null;
    }
    const live = agents.get(chat.sessionId);
    if (live !== undefined) {
      chat.agent = live;
      return live;
    }
    if (chat.creating !== null) return chat.creating;
    chat.creating = this.createAgent(chat).finally(() => {
      chat.creating = null;
    });
    return chat.creating;
  }

  /** Working directory for QQ sessions. */
  resolveCwd() {
    if (this.cachedCwd !== null) return this.cachedCwd;
    if (this.config.cwd !== null) {
      this.cachedCwd = path.resolve(this.config.cwd);
      return this.cachedCwd;
    }
    const registry = this.ctx.get('workspaceRegistry');
    if (registry !== undefined) {
      try {
        const list = registry.list();
        if (Array.isArray(list) && list.length > 0 && typeof list[0]?.path === 'string') {
          this.cachedCwd = path.resolve(list[0].path);
          return this.cachedCwd;
        }
      } catch {
        // Fall through to the process directory.
      }
    }
    this.cachedCwd = path.resolve(process.cwd());
    return this.cachedCwd;
  }

  /** True when the session is already materialized in persistence. */
  async sessionExists(sessionId) {
    const query = this.ctx.get('sessionQuery');
    if (query === undefined) return false;
    let observation;
    try {
      observation = await query.observeSession(sessionId);
    } catch {
      return false;
    }
    try {
      observation?.[Symbol.dispose]?.();
    } catch {
      // Observation cleanup is best-effort.
    }
    return true;
  }

  /** Resolve the agent preset, model, and per-agent setup for one chat. */
  async composeSetup(chat) {
    const presets = this.ctx.get('agentPresets');
    let agentPreset;
    if (presets !== undefined) {
      try {
        const resolved = await presets.resolve(this.config.agentPreset ?? undefined);
        agentPreset = resolved.id;
      } catch (error) {
        this.logger.warn(`Agent 预设解析失败，改用部署默认：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const mount = (presets !== undefined && agentPreset !== undefined)
      ? async (agentCtx) => { await presets.mount(agentCtx, agentPreset); }
      : null;
    const model = this.ctx.get('agentDefaultModel')?.currentSelection?.();
    const agentOptions = (model === undefined || model === null)
      ? {}
      : { provider: model.provider, model: model.model };
    return {
      agentPreset,
      agentOptions,
      setup: async (agentCtx, agent) => {
        if (mount !== null) await mount(agentCtx);
        this.installAgentBehavior(agentCtx, agent, chat);
      },
    };
  }

  /** Create or resume the DSH session behind one chat. */
  async createAgent(chat) {
    const agents = this.agents();
    if (agents === undefined) return null;
    const cwd = this.resolveCwd();
    const composition = await this.composeSetup(chat);
    let handle;
    try {
      if (await this.sessionExists(chat.sessionId)) {
        handle = await agents.resume({
          resumeSessionId: chat.sessionId,
          agentOptions: composition.agentOptions,
          setup: composition.setup,
        });
      } else {
        handle = await agents.create({
          sessionId: chat.sessionId,
          meta: {
            cwd,
            ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
          },
          agentOptions: composition.agentOptions,
          setup: composition.setup,
        });
        await this.attachToWorkspace(chat.sessionId, cwd);
      }
    } catch (error) {
      this.fail(`创建/恢复会话 ${chat.sessionId} 失败`, error);
      return null;
    }
    chat.handle = handle;
    chat.agent = handle.agent;
    try {
      this.ctx.get('sessionTitle')?.rename?.(handle.agent.session, chat.title);
    } catch {
      // The title is cosmetic.
    }
    this.logger.info(`已就绪 DSH 会话 ${chat.sessionId}（${chat.title}，cwd=${cwd}）`);
    return handle.agent;
  }

  /** Attach a QQ session to the DSH workspace list so it shows up in the UI. */
  async attachToWorkspace(sessionId, cwd) {
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) return;
    try {
      let workspace = await registry.resolveByPath(cwd);
      if (workspace === undefined) workspace = await registry.create(cwd);
      await workspace.attachSession(sessionId);
    } catch (error) {
      this.logger.debug?.(`会话 ${sessionId} 未挂到工作区：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Per-agent persona, scoped reply tool, and tool allow-list. */
  installAgentBehavior(agentCtx, agent, chat) {
    const persona = this.personaFor(chat);
    if (persona.length > 0) {
      try {
        // A plain string: a thunk here silently produced NO section at all in
        // this Harness build (verified live — the group fell back to the default
        // persona). Freshness is handled by retireChat() instead: editing a
        // group's prompt rebuilds that group's agent once, so the next message
        // already carries the new persona.
        agentCtx.systemPrompt.section({
          name: `qq-bridge-${chat.kind}`,
          order: 400,
          text: persona,
          interpolate: false,
        });
      } catch (error) {
        this.logger.warn(`注入人格提示失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (chat.kind !== 'remote') {
      try {
        agentCtx.tools.register(this.replyTool(chat));
      } catch (error) {
        this.logger.warn(`注册 qq_reply 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const allow = this.toolAllowFor(chat);
    if (allow === null) return;
    try {
      const globalNames = new Set(this.ctx.tools.schemas().map((schema) => schema.name));
      let expanded = expandToolAllowList(allow, globalNames);
      if (expanded.length === 0) {
        // Never fail open: a mis-spelled allow-list must not hand a QQ session
        // the whole toolset. Degrade to the bridge's own tools instead.
        this.logger.warn(`toolAllow=${JSON.stringify(allow)} 没有匹配到任何已安装工具，已退化为只允许 qq_* 工具。`);
        expanded = expandToolAllowList(['qq_*'], globalNames);
      }
      if (expanded.length === 0) return;
      agentCtx.tools.restrict({ allow: expanded });
      this.logger.debug?.(`会话 ${chat.sessionId} 工具白名单：${expanded.join(', ')}`);
    } catch (error) {
      this.logger.warn(`工具白名单应用失败（${chat.sessionId}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Persona text for one chat kind. */
  personaFor(chat) {
    const parts = [];
    if (chat.kind === 'group') {
      // A per-group override replaces the shared group persona entirely; the
      // common block, the clock and the current-group line stay appended so an
      // override cannot accidentally break reply mechanics.
      const override = this.groupPrompt(chat.chatId);
      parts.push(override.length > 0 ? override : this.config.persona.group);
    } else if (chat.kind === 'remote') {
      parts.push(this.config.persona.remote);
    } else {
      parts.push(this.config.persona.privateChat);
    }
    if (this.config.persona.common.length > 0) parts.push(this.config.persona.common);
    parts.push(`当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    if (chat.kind === 'group') {
      parts.push(`当前群：${chat.title}（群号 ${chat.chatId}）。回复时使用 qq_reply，不要自己拼 @ 文本。`);
      if (this.config.stickers.enabled) {
        parts.push('想发表情包时，用 qq_reply 的 sticker 参数（先 qq_sticker 查可用名字），不要自己编名字。');
      }
    } else if (chat.kind === 'remote' && this.config.stickers.enabled) {
      parts.push('需要发图时可以用 qq_sticker 工具。');
    }
    return parts.filter((part) => part.length > 0).join('\n\n');
  }

  /** Effective tool allow-list for one chat. */
  toolAllowFor(chat) {
    if (chat.kind === 'remote') return this.config.remote.toolAllow;
    if (chat.kind === 'group') return this.config.groupSessions.toolAllow;
    return this.config.privateChat.toolAllow;
  }

  /** The scoped tool that posts into the current QQ conversation. */
  replyTool(chat) {
    const bridge = this;
    const isGroup = chat.kind === 'group';
    return {
      name: 'qq_reply',
      description: isGroup
        ? `把一条消息发到当前 QQ 群「${chat.title}」。只有调用这个工具消息才会真正发出去；不调用就表示你在这个群里保持沉默。`
        : `把一条消息发给当前 QQ 联系人「${chat.title}」。只有调用这个工具消息才会真正发出去；不调用就表示不回复。`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: {
            type: 'string',
            description: '要发送的文本。像真人聊天一样简短口语，不要 Markdown、列表或代码块。',
          },
          at_user: {
            type: 'string',
            description: isGroup ? '可选：要 @ 的 QQ 号。默认不 @ 任何人。' : '私信忽略此参数。',
          },
          sticker: {
            type: 'string',
            description: '可选：要一起发的表情包。填 qq_sticker 列出的名字，或 face:<数字> 表示 QQ 自带表情。只发表情时 text 可以留空。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sent: { type: 'boolean' },
            skipped: { type: 'boolean' },
            dryRun: { type: 'boolean' },
            messageId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.skipped === true
            ? '内容和这一轮已经发过的完全一样，已跳过（避免在群里刷屏）。想再发一次就改一下措辞。'
            : value.dryRun === true
              ? `[dryRun] 未真正发送：${value.text}`
              : `已发送到 ${chat.title}${value.messageId ? `（消息 id ${value.messageId}）` : ''}`,
        }],
      },
      execute: async (args) => {
        const text = String(args?.text ?? '');
        const mentions = isGroup && args?.at_user ? [String(args.at_user)] : [];
        let stickers = [];
        const spec = typeof args?.sticker === 'string' ? args.sticker.trim() : '';
        if (spec.length > 0) {
          const resolved = await bridge.resolveSticker(spec);
          if (resolved.error !== undefined) throw new Error(resolved.error);
          stickers = resolved.segments;
        }
        if (text.trim().length === 0 && stickers.length === 0) {
          throw new Error('qq_reply 需要 text 或 sticker 至少一个。');
        }
        // Models occasionally emit the same call several times in one turn; in a
        // real group that is spam. Identical content is sent once per turn.
        const signature = `${mentions.join(',')}|${spec}|${text.trim()}`;
        if (chat.sentThisTurn.has(signature)) {
          return { sent: false, skipped: true, dryRun: bridge.config.dryRun, messageId: null, text: '' };
        }
        chat.sentThisTurn.add(signature);
        return bridge.sendToChat(chat, text, { mentions, stickers });
      },
    };
  }

  // ------------------------------------------------------------------ sending

  /** Send into the conversation a turn belongs to. */
  async sendToChat(chat, text, options = {}) {
    const value = String(text ?? '').trim();
    const stickers = Array.isArray(options.stickers) ? options.stickers : [];
    if (value.length === 0 && stickers.length === 0) {
      return { sent: false, dryRun: this.config.dryRun, messageId: null, text: '' };
    }
    if (chat.kind === 'group') return this.sendGroup(chat.chatId, value, { ...options, markAgentReply: true });
    return this.sendPrivate(chat.chatId, value, { ...options, markAgentReply: true });
  }
  /** Send a group message (honouring `dryRun`) and mirror it into the buffer. */
  sendGroup(groupId, text, options = {}) {
    return this.deliver({
      kind: 'group',
      chatId: String(groupId),
      text,
      mentions: options.mentions ?? [],
      stickers: options.stickers ?? [],
      markAgentReply: options.markAgentReply === true,
    });
  }

  /** Send a private message (honouring `dryRun`). */
  sendPrivate(userId, text, options = {}) {
    return this.deliver({
      kind: 'private',
      chatId: String(userId),
      text,
      mentions: [],
      stickers: options.stickers ?? [],
      markAgentReply: options.markAgentReply === true,
    });
  }

  /**
   * One outgoing message: dry-run aware, state-counted, buffer-mirrored.
   *
   * `stickers` carries ready-made OneBot segments; an empty `text` is allowed
   * when at least one sticker is present, so a pure image message works.
   */
  async deliver(request) {
    const text = String(request.text ?? '').trim();
    const stickers = Array.isArray(request.stickers) ? request.stickers.filter(Boolean) : [];
    if (text.length === 0 && stickers.length === 0) {
      return { sent: false, dryRun: this.config.dryRun, messageId: null, text: '' };
    }
    const key = request.kind === 'group' ? `group:${request.chatId}` : `private:${request.chatId}`;
    const chat = this.chats.get(key);
    const mirroredText = stickers.length === 0 ? text : `${text}${text.length > 0 ? ' ' : ''}[表情 x${stickers.length}]`;
    const mirror = () => {
      if (chat === undefined) return;
      this.record(chat, {
        time: Math.floor(Date.now() / 1000),
        userId: this.selfId ?? 'self',
        name: this.selfNickname ?? '我',
        text: mirroredText,
        mentioned: false,
        self: true,
        messageId: null,
      });
    };
    if (this.config.dryRun) {
      this.logger.info(`[dryRun] → ${request.kind}:${request.chatId}：${mirroredText.replace(/\s+/g, ' ').slice(0, 120)}`);
      mirror();
      this.noteReply(request.kind, request.chatId, mirroredText);
      return { sent: false, dryRun: true, messageId: null, text: mirroredText };
    }
    // A pure-sticker message must not carry buildTextMessage's blank spacer.
    const segments = [];
    if (text.length > 0 || (request.mentions ?? []).length > 0) {
      segments.push(...buildTextMessage(text, request.mentions ?? []));
    }
    for (const sticker of stickers) segments.push(sticker);
    let messageId = null;
    try {
      messageId = request.kind === 'group'
        ? await this.client.sendGroupMsg(request.chatId, segments)
        : await this.client.sendPrivateMsg(request.chatId, segments);
      this.connected = true;
    } catch (error) {
      this.fail(`向 ${request.kind}:${request.chatId} 发送消息失败`, error);
      throw error;
    }
    this.state.mutate((state) => {
      state.stats.repliesSent += 1;
      state.stats.lastReplyAt = Date.now();
    });
    mirror();
    if (request.markAgentReply === true) {
      const owner = this.chats.get(key);
      if (owner !== undefined) owner.agentRepliedThisTurn = true;
      if (request.kind === 'private' && this.isOwner(request.chatId)) {
        const remote = this.chats.get(`remote:${request.chatId}`);
        if (remote !== undefined) remote.agentRepliedThisTurn = true;
      }
    }
    this.noteReply(request.kind, request.chatId, text);
    this.logger.info(`← 已发送到 ${request.kind}:${request.chatId}：${mirroredText.replace(/\s+/g, ' ').slice(0, 80)}`);
    return { sent: true, dryRun: false, messageId: messageId === null ? null : String(messageId), text: mirroredText };
  }

  /** Keep a short observable log of what the bridge sent. */
  noteReply(kind, chatId, text) {
    this.recentReplies.push({ at: Date.now(), kind, chatId: String(chatId), text });
    if (this.recentReplies.length > 50) this.recentReplies.shift();
  }

  // -------------------------------------------------------- session reactions

  /** Called for every appended session event; only QQ sessions do work. */
  onSessionEvent(session, event) {
    if (this.stopped || event === null || typeof event !== 'object') return;
    const chat = this.chatBySession(session?.id);
    if (chat === undefined) return;
    if (event.type === 'assistant/message') {
      const text = contentToText(event.data?.message?.content);
      if (text.length > 0) chat.turnTexts.push(text);
      return;
    }
    if (event.type === 'turn/start') {
      chat.busy = true;
      chat.busySince = Date.now();
      return;
    }
    if (event.type === 'turn/end') {
      chat.busy = false;
      chat.busySince = null;
      void this.finishTurn(chat);
    }
  }

  /** Find the chat runtime owning a session id. */
  chatBySession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    for (const chat of this.chats.values()) {
      if (chat.sessionId === sessionId) return chat;
    }
    return undefined;
  }

  /** After a turn: relay a directly addressed answer, then drain pending work. */
  async finishTurn(chat) {
    const texts = chat.turnTexts.filter((text) => text.length > 0);
    chat.turnTexts = [];
    const answer = texts.length > 0 ? texts[texts.length - 1] : '';
    if (answer.length > 0 && chat.relayAnswer === true && chat.agentRepliedThisTurn !== true) {
      try {
        if (chat.kind === 'group') await this.sendGroup(chat.chatId, answer);
        else await this.sendPrivate(chat.chatId, answer);
      } catch {
        // deliver() already recorded the failure.
      }
    } else if (texts.length > 0 && chat.kind === 'group') {
      this.logger.debug?.(`${chat.title} 的模型只是跟了个话但没有调用 qq_reply，按自动跟聊规则保持沉默。`);
    }
    chat.agentRepliedThisTurn = false;
    chat.relayAnswer = false;
    // A persona edit while this chat was busy defers its rebuild to here, so an
    // in-flight turn is never cut off mid-answer.
    if (chat.retireAfterTurn === true) {
      chat.retireAfterTurn = false;
      await this.retireChat(chat.key);
      return;
    }
    if (chat.pending.length > 0 && !this.stopped) this.schedule(chat, 500);
  }

  /** Report an agent error; the owner hears about remote-session failures. */
  onAgentError(agent, error) {
    const chat = this.chatBySession(agent?.id);
    if (chat === undefined) return;
    chat.busy = false;
    chat.busySince = null;
    chat.lastError = error instanceof Error ? error.message : String(error);
    this.fail(`${chat.title} 的会话出错`, error);
    if (chat.kind === 'remote') {
      void this.sendPrivate(chat.chatId, `⚠️ 执行出错：${chat.lastError}`).catch(() => {});
    }
  }

  // ----------------------------------------------------------- owner commands

  /** Handle a `/` command from the owner without spending a model turn. */
  handleOwnerCommand(chat, text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return false;
    const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
    const command = String(rawCommand ?? '').toLowerCase();
    this.state.mutate((state) => { state.stats.commandsRun += 1; });
    const reply = (message) => { void this.sendPrivate(chat.chatId, message).catch(() => {}); };
    switch (command) {
      case 'help':
      case '帮助':
        reply([
          '可用指令：',
          '/status 查看桥接状态',
          '/groups 列出已知的群和模式',
          '/mode <群号> off|mention|auto 修改群聊模式',
          '/use 查看当前遥控会话',
          '/use list 列出可以路由过去的会话',
          '/use <会话 id> 把之后的指令路由到那个会话',
          '/use new 开一个全新的会话',
          '/use off 回到插件自带的专用会话',
          '/reset 开一个新的 DSH 会话（等价 /use new）',
          '/stop 打断当前任务',
          '/ping 连通性测试',
          '',
          '其他任何文字都会作为指令交给当前会话执行。',
        ].join('\n'));
        return true;
      case 'ping':
        reply(`pong（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`);
        return true;
      case 'status': {
        const status = this.status();
        reply([
          `OneBot：${status.onebot.ok ? '已连接' : `未连接（${status.onebot.error ?? '未知'}）`}`,
          `QQ：${status.self.nickname ?? ''}(${status.self.userId ?? '?'})`,
          `上报地址：${status.server.reportUrl}`,
          `会话：${status.sessions.map((item) => `${item.sessionId}${item.busy ? '(忙)' : ''}`).join('、') || '无'}`,
          `群模式：${status.groups.map((item) => `${item.groupId}=${item.mode}`).join('、') || '无'}`,
          `统计：群消息 ${status.stats.groupMessages} / 私信 ${status.stats.privateMessages} / 已回 ${status.stats.repliesSent}`,
          `dryRun：${status.dryRun ? '开（不会真的发送）' : '关'}`,
        ].join('\n'));
        return true;
      }
      case 'groups': {
        const groups = this.status().groups;
        reply(groups.length === 0
          ? '还没有见过任何群消息。把机器人拉进群并 @ 它一次就能看到。'
          : groups.map((item) => `${item.groupId}  ${item.mode}${item.allowed ? '' : '（被 allow/deny 过滤）'}`).join('\n'));
        return true;
      }
      case 'mode': {
        const [groupId, mode] = rest;
        if (!groupId || !['off', 'mention', 'auto'].includes(mode)) {
          reply('用法：/mode <群号> off|mention|auto');
          return true;
        }
        reply(`群 ${groupId} 的模式已设为 ${this.setGroupMode(groupId, mode)}`);
        return true;
      }
      case 'reset':
        void this.resetRemoteSession(chat);
        return true;
      case 'use':
        void this.handleUseCommand(chat, rest, reply);
        return true;
      case 'stop': {
        const agent = chat.agent ?? this.agents()?.get(chat.sessionId);
        if (agent === undefined || agent === null) {
          reply('当前没有正在运行的任务。');
          return true;
        }
        try {
          agent.cancel({ kind: 'user' });
          chat.pending = [];
          reply('已发送打断信号。');
        } catch (error) {
          reply(`打断失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return true;
      }
      default:
        reply(`未知指令 /${command}，发送 /help 查看可用指令。`);
        return true;
    }
  }

  /** `/use` — inspect or change where owner commands are routed. */
  async handleUseCommand(chat, rest, reply) {
    const [sub, ...tail] = rest;
    const target = tail.join(' ').trim();
    try {
      if (sub === undefined || sub === '') {
        const state = this.state.snapshot();
        const routed = state.remoteTarget;
        reply([
          `当前遥控会话：${this.remoteSessionId()}`,
          routed === null ? '（插件自带的专用会话）' : `（路由到已有会话：${routed.label}）`,
          '',
          '/use list 看有哪些会话可选；/use <会话 id> 切过去；/use new 开新的；/use off 回到专用会话。',
        ].join('\n'));
        return;
      }
      if (sub === 'list') {
        const sessions = await this.listSessions(20);
        if (sessions.length === 0) {
          reply('列不出会话（这个 profile 没有 sessionQuery 服务），可以用 /use new 直接开一个。');
          return;
        }
        const current = this.remoteSessionId();
        reply([
          '最近的会话（最新的在前）：',
          ...sessions.map((session, index) => {
            const mark = session.sessionId === current ? ' ←当前' : '';
            const title = session.title ?? '（无标题）';
            return `${index + 1}. ${session.sessionId}  ${title}${session.live ? '  [在线]' : ''}${mark}`;
          }),
          '',
          '用 /use <会话 id> 切过去。',
        ].join('\n'));
        return;
      }
      if (sub === 'off') {
        const id = await this.clearRemoteTarget();
        reply(`已回到插件自带的专用会话：${id}`);
        return;
      }
      if (sub === 'new') {
        await this.resetRemoteSession(chat);
        return;
      }
      const sessionId = sub;
      let label = sessionId;
      if (target.length > 0) {
        // `/use <id> <备注>` — find the id by prefix match among recent sessions.
        const sessions = await this.listSessions(200);
        const hit = sessions.find((session) => session.sessionId === sessionId);
        if (hit !== undefined) label = `${hit.title ?? sessionId}（${sessionId}）`;
      } else {
        const sessions = await this.listSessions(200);
        const hit = sessions.find((session) => session.sessionId === sessionId);
        if (hit !== undefined) label = `${hit.title ?? sessionId}（${sessionId}）`;
      }
      await this.setRemoteTarget(sessionId, label);
      reply([
        `之后的指令都会路由到会话：${label}`,
        '（如果那个会话当前没在运行，插件会自动恢复它；它的回复会照常传回这里。）',
      ].join('\n'));
    } catch (error) {
      reply(`/use 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Retire the current remote session and start a fresh one. */
  async resetRemoteSession(chat) {
    const previous = chat.sessionId;
    const handle = chat.handle;
    chat.handle = null;
    chat.agent = null;
    chat.busy = false;
    chat.busySince = null;
    chat.pending = [];
    chat.sentThisTurn = new Set();
    chat.turnTexts = [];
    this.chats.delete(chat.key);
    if (handle !== null) {
      try {
        await handle.dispose();
      } catch (error) {
        this.logger.warn(`关闭旧会话 ${previous} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const next = `${this.config.remote.sessionId}-${Date.now().toString(36)}`;
    this.state.mutate((state) => {
      state.remoteTarget = null;
      state.remoteSessionId = next;
    });
    await this.state.flush();
    await this.sendPrivate(chat.chatId, `已开始新的会话：${next}`).catch(() => {});
  }

  // ------------------------------------------------------------------- status

  /** Snapshot used by the tools and `/status`. */
  status() {
    const state = this.state.snapshot();
    const groups = [];
    const seen = new Set();
    const pushGroup = (groupId, mode, source) => {
      const id = String(groupId);
      if (seen.has(id)) return;
      seen.add(id);
      const known = state.groups[id];
      groups.push({
        groupId: id,
        mode,
        allowed: this.groupAllowed(id),
        source,
        title: known?.title ?? null,
        lastSeen: known?.lastSeen ?? null,
      });
    };
    // The durable registry first: a group's row must survive a retired chat
    // (editing its prompt) and a DSH restart, not just live traffic.
    for (const [groupId, info] of Object.entries(state.groups)) {
      pushGroup(groupId, this.modeFor(groupId), state.groupModes[groupId] !== undefined ? 'runtime' : 'known');
      void info;
    }
    for (const [groupId, mode] of Object.entries(state.groupModes)) pushGroup(groupId, mode, 'runtime');
    for (const [groupId, mode] of Object.entries(this.config.groups)) pushGroup(groupId, mode, 'config');
    for (const chat of this.chats.values()) {
      if (chat.kind !== 'group') continue;
      pushGroup(chat.chatId, chat.mode, 'observed');
    }
    // Every group that carries a persona override, plus its provenance.
    const groupPrompts = {};
    for (const groupId of new Set([...Object.keys(this.config.groupPrompts), ...Object.keys(state.groupPrompts)])) {
      groupPrompts[groupId] = {
        prompt: this.groupPrompt(groupId),
        source: typeof state.groupPrompts[groupId] === 'string' ? 'runtime' : 'config',
      };
    }
    for (const group of groups) {
      if (groupPrompts[group.groupId] === undefined) {
        groupPrompts[group.groupId] = { prompt: '', source: 'default' };
      }
    }
    return {
      enabled: this.config.enabled,
      dryRun: this.config.dryRun,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt === null ? 0 : Date.now() - this.startedAt,
      onebot: {
        baseUrl: this.client.baseUrl,
        connected: this.connected,
        ok: this.lastProbe?.ok === true,
        error: this.lastProbe?.ok === false ? this.lastProbe.error : null,
        probedAt: this.lastProbe?.at ?? null,
      },
      self: { userId: this.selfId, nickname: this.selfNickname },
      server: {
        reportUrl: this.server.reportUrl,
        listening: this.server.server !== null,
        host: this.server.host,
        port: this.server.port,
        path: this.server.path,
        secret: this.config.reportSecret.length > 0,
        stats: { ...this.server.stats },
      },
      dataDir: this.state.dir,
      owners: this.config.ownerIds,
      overrides: this.overrides(),
      privateFromOthers: this.config.privateFromOthers,
      defaultGroupMode: this.config.defaultGroupMode,
      groupPrompts,
      remoteTarget: state.remoteTarget,
      remoteSessionId: this.remoteSessionId(),
      stickers: {
        enabled: this.config.stickers.enabled,
        dir: this.stickerDirectory(),
      },
      clientProcess: this.child === null ? null : { pid: this.child.pid ?? null },
      groups,
      sessions: [...this.chats.values()].map((chat) => ({
        key: chat.key,
        kind: chat.kind,
        title: chat.title,
        sessionId: chat.sessionId,
        live: chat.agent !== null,
        busy: chat.busy,
        pending: chat.pending.length,
        buffered: chat.buffer.length,
        turnsThisHour: chat.turnCount,
        lastTurnAt: chat.lastTurnAt,
        lastError: chat.lastError,
      })),
      stats: { ...state.stats },
      recentReplies: this.recentReplies.slice(-10),
    };
  }

  /** Recent messages the bridge has seen in one chat. */
  recentMessages(kind, chatId, count) {
    const chat = this.chats.get(`${kind}:${String(chatId)}`);
    if (chat === undefined) return [];
    const limit = Number.isSafeInteger(count) && count > 0 ? Math.min(count, chat.buffer.length) : 20;
    return chat.buffer.slice(-limit).map((entry) => ({
      time: entry.time,
      at: new Date(entry.time * 1000).toLocaleString('zh-CN', { hour12: false }),
      userId: entry.userId,
      name: entry.name,
      text: entry.text,
      self: entry.self,
    }));
  }

  /** Record a failure in the state file and the log. */
  fail(subject, error) {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`${subject}：${message}`);
    this.state.mutate((state) => { state.stats.lastError = `${subject}：${message}`; });
  }
}

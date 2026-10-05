/**
 * The agent-facing tool surface of the QQ bridge.
 *
 * Every tool returns the same tiny shape — `{ text }` — so a tool result is
 * always readable prose for the model, whatever the underlying OneBot payload
 * looked like. Failures throw, which the Harness renders as a tool error.
 */

/** Shared output definition: one block of prose. */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
};

/** Build one registry-ready tool definition. */
function tool(name, description, properties, required, execute) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required === undefined || required.length === 0 ? {} : { required }),
    },
    output: TEXT_OUTPUT,
    execute,
  };
}

/** Render a timestamp as a local clock time. */
function at(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '未知';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** Format a QQ number for display, tolerating string/number inputs. */
function qq(value) {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : '?';
}

/**
 * Register every global QQ tool on the plugin context.
 *
 * @param {any} ctx Plugin context (already declares the `tools` dependency).
 * @param {import('./bridge.js').QqBridge} bridge
 */
export function registerTools(ctx, bridge) {
  const dispose = [];

  dispose.push(ctx.tools.register(tool(
    'qq_status',
    '查看 QQ 桥的当前状态：OneBot 连接、登录的 QQ 号、事件上报地址、群聊模式、各会话是否繁忙、收发统计。排查 QQ 相关问题时先调用它。',
    {},
    [],
    async () => {
      const status = bridge.status();
      const lines = [
        `启用：${status.enabled ? '是' : '否'}    试运行(dryRun)：${status.dryRun ? '是（不会真的发送）' : '否'}`,
        `OneBot：${status.onebot.ok ? '已连接' : '未连接'}  ${status.onebot.baseUrl}${status.onebot.error ? `  错误：${status.onebot.error}` : ''}`,
        `登录 QQ：${status.self.nickname ?? '未知'}(${status.self.userId ?? '未知'})`,
        `事件上报地址：${status.server.reportUrl}  监听中：${status.server.listening ? '是' : '否'}  校验签名：${status.server.secret ? '是' : '否'}`,
        `状态文件：${status.dataDir}`,
        `主人 QQ：${status.owners.join('、') || '（未配置）'}    非主人私信策略：${status.privateFromOthers}`,
        `群聊默认模式：${status.defaultGroupMode}`,
        `遥控会话：${status.remoteSessionId}${status.remoteTarget === null ? '（插件专用）' : `（路由到 ${status.remoteTarget.label}）`}`,
        `表情库：${status.stickers.enabled ? status.stickers.dir : '已关闭'}`,
        `已装工具：qq_status / qq_config / qq_list_groups / qq_list_friends / qq_group_members / qq_send_group / qq_send_private / qq_recent_messages / qq_group_mode / qq_group_prompt / qq_sticker / qq_remote / qq_chats / qq_client`,
        '',
        '群与模式：',
        ...(status.groups.length === 0
          ? ['  （还没有见过任何群）']
          : status.groups.map((group) => `  ${group.groupId}  模式=${group.mode}  来源=${group.source}${group.allowed ? '' : '  已被 allow/deny 过滤'}`)),
        '',
        '会话：',
        ...(status.sessions.length === 0
          ? ['  （还没有活跃的 QQ 会话）']
          : status.sessions.map((session) => `  ${session.title}  ${session.sessionId}  在线=${session.live ? '是' : '否'}  ${session.busy ? '正在回复' : '空闲'}  待处理=${session.pending}  本小时轮次=${session.turnsThisHour}${session.lastError ? `  最近错误=${session.lastError}` : ''}`)),
        '',
        `统计：收到上报 ${status.stats.eventsReceived}，群消息 ${status.stats.groupMessages}，私信 ${status.stats.privateMessages}，触发轮次 ${status.stats.turnsStarted}，已回消息 ${status.stats.repliesSent}`,
        `最近事件：${at(status.stats.lastEventAt)}    最近回复：${at(status.stats.lastReplyAt)}`,
      ];
      if (status.stats.lastError) lines.push(`最近错误：${status.stats.lastError}`);
      return { text: lines.join('\n') };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_list_groups',
    '列出这个 QQ 号加入的所有群（群号、群名、人数）。用来确认群号，或在回答前了解机器人在哪些群里。',
    {},
    [],
    async () => {
      const list = await bridge.client.getGroupList();
      if (!Array.isArray(list) || list.length === 0) return { text: '这个 QQ 号当前没有加入任何群。' };
      const lines = list.map((group) => {
        const id = qq(group?.group_id);
        const name = group?.group_name ?? '';
        const count = group?.member_count ?? '?';
        const max = group?.max_member_count ?? '?';
        const mode = bridge.modeFor(id);
        return `${id}  ${name}  ${count}/${max} 人  本地模式=${mode}`;
      });
      await bridge.refreshGroupNames();
      return { text: `共 ${list.length} 个群：\n${lines.join('\n')}` };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_list_friends',
    '列出这个 QQ 号的好友（QQ 号、昵称、备注）。',
    {},
    [],
    async () => {
      const list = await bridge.client.getFriendList();
      if (!Array.isArray(list) || list.length === 0) return { text: '这个 QQ 号当前没有好友。' };
      const lines = list.map((friend) => `${qq(friend?.user_id)}  ${friend?.nickname ?? ''}  ${friend?.remark ?? ''}`.trimEnd());
      return { text: `共 ${list.length} 个好友：\n${lines.join('\n')}` };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_group_members',
    '列出某个群的成员（QQ 号、群名片/昵称、角色）。想在群里 @ 具体某个人之前先用它拿到 QQ 号。',
    {
      group_id: { type: 'string', description: '群号。' },
    },
    ['group_id'],
    async (args) => {
      const groupId = qq(args?.group_id);
      const list = await bridge.client.getGroupMemberList(groupId);
      if (!Array.isArray(list) || list.length === 0) return { text: `群 ${groupId} 没有取到成员列表。` };
      const lines = list.map((member) => {
        const role = member?.role === 'owner' ? '群主' : member?.role === 'admin' ? '管理' : '成员';
        return `${qq(member?.user_id)}  ${member?.card || member?.nickname || ''}  ${role}`;
      });
      return { text: `群 ${groupId} 共 ${list.length} 人：\n${lines.join('\n')}` };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_send_group',
    '往指定 QQ 群发送一条文本消息。这是主动发言，会真的打扰到群里的人：只在确实需要时使用，并且内容要简短口语。发到当前正在对话的群时优先用 qq_reply。',
    {
      group_id: { type: 'string', description: '目标群号。' },
      text: { type: 'string', description: '要发送的文本，不要 Markdown。' },
      at_user: { type: 'string', description: '可选：要 @ 的 QQ 号。默认不 @ 任何人。' },
    },
    ['group_id', 'text'],
    async (args) => {
      const groupId = qq(args?.group_id);
      const mentions = args?.at_user ? [qq(args.at_user)] : [];
      const result = await bridge.sendGroup(groupId, String(args?.text ?? ''), { mentions, markAgentReply: true });
      return {
        text: result.dryRun
          ? `[dryRun] 没有真正发送。本应发到群 ${groupId}：${result.text}`
          : `已发送到群 ${groupId}${result.messageId ? `（消息 id ${result.messageId}）` : ''}：${result.text}`,
      };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_send_private',
    '给指定 QQ 号发送一条私信。给主人回话时优先直接写正常回复（会自动发回）；只有在需要补充额外消息时才用它。',
    {
      user_id: { type: 'string', description: '目标 QQ 号。' },
      text: { type: 'string', description: '要发送的文本。' },
    },
    ['user_id', 'text'],
    async (args) => {
      const userId = qq(args?.user_id);
      const result = await bridge.sendPrivate(userId, String(args?.text ?? ''), { markAgentReply: true });
      return {
        text: result.dryRun
          ? `[dryRun] 没有真正发送。本应发给 ${userId}：${result.text}`
          : `已发送给 ${userId}${result.messageId ? `（消息 id ${result.messageId}）` : ''}：${result.text}`,
      };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_recent_messages',
    '读取 QQ 桥最近看到的消息（来自本机缓存，不依赖 OneBot 的历史接口）。用来回看某个群或某个人的对话上下文。只包含机器人上线后收到的消息。',
    {
      chat_type: { type: 'string', enum: ['group', 'private'], description: '群聊填 group，私信填 private。' },
      chat_id: { type: 'string', description: '群号或 QQ 号。' },
      count: { type: 'integer', description: '最多返回多少条，默认 20。' },
    },
    ['chat_type', 'chat_id'],
    async (args) => {
      const chatType = args?.chat_type === 'private' ? 'private' : 'group';
      const chatId = qq(args?.chat_id);
      const messages = bridge.recentMessages(chatType, chatId, Number(args?.count ?? 20));
      if (messages.length === 0) {
        return { text: `本地缓存里没有 ${chatType}:${chatId} 的消息。可能这个会话还没来过消息，或者消息在机器人启动之前。` };
      }
      const lines = messages.map((message) => `${message.at}  ${message.self ? '（我）' : ''}${message.name}(${message.userId})：${message.text}`);
      return { text: `${chatType}:${chatId} 最近 ${messages.length} 条：\n${lines.join('\n')}` };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_group_mode',
    '查看或修改某个群的应答模式。off=完全不理会；mention=只有被 @ 时才回复；auto=自动跟聊，群安静一段时间后自己决定要不要说话。不传 mode 就是查询。',
    {
      group_id: { type: 'string', description: '群号。' },
      mode: { type: 'string', enum: ['off', 'mention', 'auto'], description: '留空表示只查询当前模式。' },
      reset: { type: 'boolean', description: 'true 表示清除运行时设置，回到配置文件里的默认值。' },
    },
    ['group_id'],
    async (args) => {
      const groupId = qq(args?.group_id);
      if (args?.reset === true) {
        return { text: `群 ${groupId} 的运行时模式已清除，当前生效模式：${bridge.setGroupMode(groupId, null)}` };
      }
      if (args?.mode === undefined || args?.mode === null || String(args.mode).length === 0) {
        const allowed = bridge.groupAllowed(groupId);
        return { text: `群 ${groupId} 当前模式：${bridge.modeFor(groupId)}${allowed ? '' : '（但被 allowGroups/denyGroups 过滤，实际不会响应）'}` };
      }
      const mode = String(args.mode);
      if (!['off', 'mention', 'auto'].includes(mode)) throw new Error(`不支持的群模式：${mode}（只能是 off / mention / auto）`);
      return { text: `群 ${groupId} 的模式已设为 ${bridge.setGroupMode(groupId, mode)}（已写入状态文件，重启后仍然有效）` };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_chats',
    '列出 QQ 桥参与的所有会话：群聊、陌生人私信、主人的遥控会话，以及它们各自的模式、是否在线、待处理消息数和本小时已用的轮次预算。',
    {},
    [],
    async () => {
      const status = bridge.status();
      if (status.sessions.length === 0) {
        return { text: '目前还没有任何 QQ 会话。等第一条群消息或私信到达后就会自动创建。' };
      }
      const lines = status.sessions.map((session) => [
        `${session.title}  [${session.kind}]`,
        `  会话 id：${session.sessionId}`,
        `  状态：${session.live ? '在线' : '未启动'} / ${session.busy ? '正在回复' : '空闲'}`,
        `  模式：${session.kind === 'group' ? bridge.modeFor(session.sessionId.replace(bridge.config.groupSessions.sessionPrefix, '')) : '—'}`,
        `  待处理：${session.pending} 条    缓存：${session.buffered} 条    本小时轮次：${session.turnsThisHour}/${bridge.config.maxTurnsPerHour}`,
        session.lastError ? `  最近错误：${session.lastError}` : null,
      ].filter(Boolean).join('\n'));
      return { text: lines.join('\n\n') };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_config',
    '查看或修改 QQ 桥的运行时配置（连接地址、访问令牌、主人 QQ、群聊默认模式、dryRun、每小时轮次上限等），修改会立即生效并写入状态文件，重启后仍然有效，不需要改 YAML。show 查看当前配置。',
    {
      action: {
        type: 'string',
        enum: ['show', 'endpoint', 'owner', 'default_mode', 'dry_run', 'private_from_others', 'max_turns', 'reset'],
        description: '要执行的操作。endpoint 设置 OneBot 地址/令牌；owner 增删主人 QQ；default_mode 设置群聊默认模式；dry_run 切换试运行；private_from_others 设置非主人私信策略；reset 用 value 指定要清除的配置项（all 清除全部）。',
      },
      api_base_url: { type: 'string', description: 'OneBot HTTP API 根地址，例如 http://127.0.0.1:3000。' },
      access_token: { type: 'string', description: 'OneBot access token；留空表示不修改。' },
      owner_id: { type: 'string', description: '主人的 QQ 号。' },
      remove: { type: 'boolean', description: 'owner 操作时 true 表示删除这个 QQ 号。' },
      mode: { type: 'string', enum: ['off', 'mention', 'auto'], description: '群聊默认模式。' },
      enabled: { type: 'boolean', description: 'dry_run 操作时：true 打开试运行（不真的发消息），false 关闭。' },
      value: { type: 'string', description: 'private_from_others 填 ignore/chat；reset 填要清除的键名或 all。' },
    },
    ['action'],
    async (args) => {
      const action = String(args?.action ?? 'show');
      const maskToken = (token) => (token.length === 0 ? '（空）' : `${token.slice(0, 3)}***${token.slice(-2)}`);
      const describe = () => {
        const status = bridge.status();
        return [
          `OneBot 地址：${status.onebot.baseUrl}`,
          `访问令牌：${maskToken(bridge.config.accessToken)}`,
          `主人 QQ：${status.owners.join('、') || '（未配置，遥控通道关闭）'}`,
          `群聊默认模式：${status.defaultGroupMode}`,
          `非主人私信：${status.privateFromOthers}`,
          `dryRun：${status.dryRun ? '开（不会真的发送）' : '关'}`,
          `每小时轮次上限：${bridge.config.maxTurnsPerHour}（每个会话各自算）`,
          `事件上报地址：${status.server.reportUrl}`,
          `已覆盖的运行时配置：${Object.keys(status.overrides).join('、') || '（无）'}`,
          '',
          '把上面的「事件上报地址」填到 OneBot 客户端的 HTTP 上报设置里。',
        ].join('\n');
      };
      if (action === 'show') return { text: describe() };
      if (action === 'endpoint') {
        const baseUrl = String(args?.api_base_url ?? '').trim();
        if (baseUrl.length === 0) throw new Error('endpoint 需要 api_base_url，例如 http://127.0.0.1:3000');
        await bridge.setOverride('apiBaseUrl', baseUrl);
        const token = typeof args?.access_token === 'string' ? args.access_token : '';
        if (token.length > 0) await bridge.setOverride('accessToken', token);
        const probe = await bridge.refreshIdentity();
        return {
          text: `${probe.ok
            ? `已连接：${probe.nickname ?? ''}(${probe.userId ?? '?'})`
            : `已保存，但连接失败：${probe.error}`}\n\n${describe()}`,
        };
      }
      if (action === 'owner') {
        const ownerId = String(args?.owner_id ?? '').trim();
        if (!/^\d{5,12}$/.test(ownerId)) throw new Error('owner_id 必须是 5~12 位的 QQ 号');
        const current = bridge.config.ownerIds.slice();
        const remove = args?.remove === true;
        const next = remove
          ? current.filter((id) => id !== ownerId)
          : (current.includes(ownerId) ? current : [...current, ownerId]);
        await bridge.setOverride('ownerIds', next);
        return { text: `主人 QQ 现在是：${next.join('、') || '（空，遥控通道已关闭）'}${remove ? '' : '。用这个号私信机器人即可远程指挥 DSH。'}` };
      }
      if (action === 'default_mode') {
        const mode = String(args?.mode ?? '');
        if (!['off', 'mention', 'auto'].includes(mode)) throw new Error('mode 只能是 off / mention / auto');
        await bridge.setOverride('defaultGroupMode', mode);
        return { text: `群聊默认模式已设为 ${mode}（单个群的设置优先，可用 qq_group_mode 调整）。` };
      }
      if (action === 'dry_run') {
        const enabled = args?.enabled === true;
        await bridge.setOverride('dryRun', enabled);
        return { text: enabled ? '已打开 dryRun：所有要发出去的消息只会写进日志，不会真的发送。' : '已关闭 dryRun：消息会真的发到 QQ。' };
      }
      if (action === 'max_turns') {
        const turns = Number(args?.value);
        if (!Number.isSafeInteger(turns) || turns <= 0) throw new Error('value 必须是正整数（每小时最多跑多少轮）');
        const applied = await bridge.setOverride('maxTurnsPerHour', turns);
        return {
          text: [
            `每小时轮次上限已设为 ${applied}（每个会话各自计算，滚动一小时）。`,
            '调大之前先想清楚：每一轮都是一次模型调用，auto 模式的群会实实在在地花掉额度。',
          ].join('\n'),
        };
      }
      if (action === 'private_from_others') {
        const value = String(args?.value ?? '');
        if (!['ignore', 'chat'].includes(value)) throw new Error('value 只能是 ignore 或 chat');
        await bridge.setOverride('privateFromOthers', value);
        return { text: value === 'chat' ? '陌生人私信现在会各自开一个 DSH 会话来聊天。' : '陌生人私信现在被忽略。' };
      }
      const key = String(args?.value ?? '').trim();
      if (key.length === 0) throw new Error('reset 需要在 value 里写明要清除的键名，或填 all');
      const keys = key === 'all' ? Object.keys(bridge.overrides()) : [key];
      if (keys.length === 0) return { text: '当前没有任何运行时覆盖，无需清除。' };
      for (const entry of keys) await bridge.setOverride(entry, null);
      return { text: `已清除运行时覆盖：${keys.join('、')}。现在回到 bundle patch 里的默认值。\n\n${describe()}` };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_group_prompt',
    '查看或修改某个群专用的提示词（人设）。设了之后，那个群的机器人人格就用这一段，替换掉全局的群聊人设。',
    {
      group_id: { type: 'string', description: '群号。' },
      prompt: { type: 'string', description: '这个群专用的提示词全文。留空或省略表示只查询；传空串表示清除。' },
      clear: { type: 'boolean', description: 'true 表示清除这个群的专用提示词。' },
    },
    ['group_id'],
    async (args) => {
      const groupId = qq(args?.group_id);
      if (args?.clear === true) {
        bridge.setGroupPrompt(groupId, '');
        return { text: `群 ${groupId} 的专用提示词已清除，回到全局群聊人设。` };
      }
      if (typeof args?.prompt !== 'string') {
        const current = bridge.groupPrompt(groupId);
        return {
          text: current.length === 0
            ? `群 ${groupId} 目前没有专用提示词，使用全局群聊人设。`
            : `群 ${groupId} 当前专用提示词：\n${current}`,
        };
      }
      if (args.prompt.trim().length === 0) {
        bridge.setGroupPrompt(groupId, '');
        return { text: `群 ${groupId} 的专用提示词已清除。` };
      }
      const saved = bridge.setGroupPrompt(groupId, args.prompt);
      return { text: `群 ${groupId} 的专用提示词已更新（${saved.length} 字），下一条消息生效：\n${saved}` };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_sticker',
    '表情包。action=list 列出表情库里可用的名字；action=send 把表情（可带一句话）发到指定群或私聊。表情库是一个文件夹，把图片丢进去即可；也支持 face:<数字> 发 QQ 自带表情。',
    {
      action: { type: 'string', enum: ['list', 'send'], description: '要执行的操作。' },
      target_kind: { type: 'string', enum: ['group', 'private'], description: 'send 时的目标类型。' },
      target_id: { type: 'string', description: 'send 时的群号或 QQ 号。' },
      sticker: { type: 'string', description: '表情库里的名字、face:<数字>、图片 URL，或本机图片的绝对路径。' },
      text: { type: 'string', description: '可选：跟表情一起发的一句话。' },
      at_user: { type: 'string', description: '可选：发到群里时同时 @ 的 QQ 号。' },
    },
    ['action'],
    async (args) => {
      const action = String(args?.action ?? 'list');
      if (action === 'list') {
        if (!bridge.config.stickers.enabled) return { text: '表情包功能已在配置里关闭（stickers.enabled = false）。' };
        const items = await bridge.listStickers();
        const dir = bridge.stickerDirectory();
        if (items.length === 0) {
          return { text: `表情库还是空的。把图片放进这个文件夹就能用了：\n${dir}\n（支持 png / jpg / jpeg / gif / webp / bmp）` };
        }
        return {
          text: `表情库共 ${items.length} 个（目录 ${dir}）：\n${items.map((item) => item.name).join('、')}\n\n发送：qq_sticker { action: "send", target_kind: "group", target_id: "群号", sticker: "名字" }`,
        };
      }
      if (!bridge.config.stickers.enabled) throw new Error('表情包功能已在配置里关闭（stickers.enabled = false）');
      const kind = args?.target_kind === 'private' ? 'private' : 'group';
      const targetId = qq(args?.target_id);
      if (targetId === '?') throw new Error('send 需要 target_id（群号或 QQ 号）');
      const spec = String(args?.sticker ?? '').trim();
      if (spec.length === 0) throw new Error('send 需要 sticker（名字 / face:<数字> / URL / 绝对路径）');
      const resolved = await bridge.resolveSticker(spec);
      if (resolved.error !== undefined) throw new Error(resolved.error);
      const text = String(args?.text ?? '');
      const mentions = kind === 'group' && args?.at_user ? [qq(args.at_user)] : [];
      const result = kind === 'group'
        ? await bridge.sendGroup(targetId, text, { mentions, stickers: resolved.segments })
        : await bridge.sendPrivate(targetId, text, { stickers: resolved.segments });
      return {
        text: result.dryRun
          ? `[dryRun] 没有真正发送。本应发 ${resolved.label} 到 ${kind}:${targetId}`
          : `已把「${resolved.label}」发到 ${kind}:${targetId}${result.messageId ? `（消息 id ${result.messageId}）` : ''}`,
      };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_remote',
    '主人的私信遥控通道：查看或切换指令被路由到哪个 DSH 会话。',
    {
      action: { type: 'string', enum: ['status', 'list', 'use', 'new', 'off'], description: 'status 看当前路由；list 列出可选的会话；use 切到某个会话；new 开新会话；off 回到专用会话。' },
      session_id: { type: 'string', description: 'use 时的目标会话 id。' },
      limit: { type: 'integer', description: 'list 返回多少条，默认 25。' },
    },
    ['action'],
    async (args) => {
      const action = String(args?.action ?? 'status');
      if (action === 'status') {
        const target = bridge.status().remoteTarget;
        return {
          text: [
            `当前遥控会话：${bridge.remoteSessionId()}`,
            target === null ? '（插件自带的专用会话）' : `（路由到已有会话：${target.label}）`,
            '主人 QQ：' + (bridge.config.ownerIds.join('、') || '（未配置）'),
          ].join('\n'),
        };
      }
      if (action === 'list') {
        const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? args.limit : 25;
        const sessions = await bridge.listSessions(limit);
        if (sessions.length === 0) return { text: '列不出会话（这个 profile 可能没有 sessionQuery 服务）。可以用 qq_remote { action: "new" } 直接开一个。' };
        const current = bridge.remoteSessionId();
        return {
          text: `最近 ${sessions.length} 个会话（最新在前）：\n${sessions.map((session) => {
            const mark = session.sessionId === current ? '  ←当前' : '';
            return `${session.sessionId}  ${session.title ?? '（无标题）'}${session.live ? '  [在线]' : ''}${mark}`;
          }).join('\n')}\n\n用 qq_remote { action: "use", session_id: "…" } 切过去。`,
        };
      }
      if (action === 'off') {
        const id = await bridge.clearRemoteTarget();
        return { text: `已回到插件自带的专用会话：${id}` };
      }
      if (action === 'new') {
        const chat = bridge.remoteChat(bridge.config.ownerIds[0] ?? 'owner');
        await bridge.resetRemoteSession(chat);
        return { text: `已开一个新的遥控会话：${bridge.remoteSessionId()}。之后主人的私信都会进这里。` };
      }
      const sessionId = String(args?.session_id ?? '').trim();
      if (sessionId.length === 0) throw new Error('use 需要 session_id');
      const sessions = await bridge.listSessions(200);
      const hit = sessions.find((session) => session.sessionId === sessionId);
      await bridge.setRemoteTarget(sessionId, hit === undefined ? sessionId : `${hit.title ?? sessionId}（${sessionId}）`);
      return {
        text: `之后主人的私信都会路由到会话 ${sessionId}${hit === undefined ? '（在最近的会话列表里没找到它，如果 id 写错了会失败）' : `（${hit.title ?? '无标题'}）`}。回复会照常传回 QQ。`,
      };
    },
  )));

  dispose.push(ctx.tools.register(tool(
    'qq_client',
    '管理本机 OneBot 客户端进程，或探测与它的连接。action=probe 检查连接和登录信息；launch 启动配置里的客户端程序；stop 关闭由本插件启动的进程；version 读取 OneBot 实现名称和版本。',
    {
      action: { type: 'string', enum: ['probe', 'launch', 'stop', 'version'], description: '要执行的操作。' },
    },
    ['action'],
    async (args) => {
      const action = String(args?.action ?? 'probe');
      if (action === 'probe') {
        const probe = await bridge.refreshIdentity();
        return {
          text: probe.ok
            ? `OneBot 连接正常：${probe.nickname ?? ''}(${probe.userId ?? '?'})  地址 ${bridge.client.baseUrl}`
            : `OneBot 连接失败：${probe.error}\n请确认客户端已登录、HTTP API 端口与 apiBaseUrl 一致、accessToken 正确。事件上报地址应为 ${bridge.server.reportUrl}`,
        };
      }
      if (action === 'launch') {
        const result = await bridge.launchClient();
        return { text: result.ok ? `已请求启动客户端${result.pid ? `（pid ${result.pid}）` : ''}。${result.alreadyRunning ? '（之前已经在运行）' : ''}` : `启动失败：${result.error}。请检查 client.command / client.args 配置。` };
      }
      if (action === 'stop') {
        const result = bridge.stopClient();
        return { text: result.stopped ? '已关闭本插件启动的 OneBot 客户端进程。' : '本插件没有启动过客户端进程，未做任何操作。' };
      }
      const version = await bridge.client.getVersionInfo();
      return { text: `OneBot 实现：${version?.app_name ?? '未知'} ${version?.app_version ?? ''}  协议版本：${version?.protocol_version ?? '未知'}` };
    },
  )));

  return () => {
    for (const disposer of dispose) {
      try {
        disposer();
      } catch {
        // Unregistration is best-effort during teardown.
      }
    }
  };
}

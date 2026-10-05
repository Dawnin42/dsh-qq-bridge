/**
 * dsh-qq-bridge — Web client half.
 *
 * Renders the "QQ-bot" page inside the Harness settings panel and talks to the
 * Host plugin over the Connection RPC channel `/qq-bridge`.
 *
 * Rules this file follows (see docs/client-page-plan.md):
 *   - the module-loader entry is a `window.__ModuleLoader__.load({ id, factory })`
 *     call whose `id` equals the package name;
 *   - `factory` is side-effect free and returns `{ inject, apply }`;
 *   - only `react` is imported — no `@deepseek-ai/*` client package;
 *   - every colour comes from a `--dsw-alias-*` theme token, so light and dark
 *     both work with no extra code.
 */

window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: (require) => {
    const module = { exports: {} };
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const CHANNEL = '/qq-bridge';
    const MODES = ['off', 'mention', 'auto'];
    const MODE_LABEL = { off: '不理会', mention: '仅 @ 响应', auto: '自动跟聊' };

    const CSS = [
      '.qqb-root{display:flex;flex-direction:column;width:100%;box-sizing:border-box;',
      'font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);}',
      '.qqb-h{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);',
      'margin:20px 0 4px;letter-spacing:.02em;}',
      '.qqb-h:first-child{margin-top:0;}',
      '.qqb-row{display:flex;align-items:center;justify-content:space-between;gap:20px;',
      'padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);}',
      '.qqb-row:last-child{border-bottom:none;}',
      '.qqb-text{display:flex;flex-direction:column;flex:1;min-width:0;gap:2px;}',
      '.qqb-title{font-size:14px;line-height:22px;}',
      '.qqb-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);',
      'word-break:break-all;}',
      '.qqb-ctl{display:inline-flex;align-items:center;gap:8px;flex:none;}',
      '.qqb-val{font-variant-numeric:tabular-nums;text-align:right;word-break:break-all;}',
      '.qqb-in,.qqb-sel{box-sizing:border-box;height:32px;padding:0 8px;font:inherit;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;}',
      '.qqb-in{min-width:220px;}',
      '.qqb-in::placeholder{color:var(--dsw-alias-label-secondary);}',
      '.qqb-btn{box-sizing:border-box;height:32px;padding:0 12px;font:inherit;cursor:pointer;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;}',
      '.qqb-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);}',
      '.qqb-btn:disabled{opacity:.5;cursor:default;}',
      '.qqb-btn--primary{color:var(--dsw-alias-brand-primary);',
      'border-color:var(--dsw-alias-brand-primary);}',
      '.qqb-check{width:16px;height:16px;margin:0;cursor:pointer;',
      'accent-color:var(--dsw-alias-brand-primary);}',
      '.qqb-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;',
      'vertical-align:middle;}',
      '.qqb-tag{display:inline-block;padding:0 6px;margin-left:6px;border-radius:4px;font-size:12px;',
      'border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}',
      '.qqb-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;',
      'padding:8px 0;}',
      '.qqb-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}',
      '.qqb-head{display:flex;align-items:center;justify-content:space-between;gap:12px;',
      'padding:0 0 4px;}',
      '.qqb-name{font-size:16px;font-weight:600;line-height:24px;}',
      '.qqb-list{display:flex;flex-wrap:wrap;gap:8px;padding:4px 0;}',
      '.qqb-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;margin:8px 0;overflow:hidden;}',
      '.qqb-cardHead{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;}',
      '.qqb-cardBody{display:flex;flex-direction:column;gap:8px;padding:0 12px 12px;}',
      '.qqb-cardActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.qqb-ta{box-sizing:border-box;width:100%;resize:vertical;font:inherit;line-height:20px;padding:8px 10px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;}',
      '.qqb-ta::placeholder{color:var(--dsw-alias-label-secondary);}',
      '.qqb-picker{display:flex;flex-wrap:wrap;gap:8px;padding:8px 0;max-height:220px;overflow:auto;}',
      '.qqb-picker .qqb-btn{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;}',
      '.qqb-qr{display:flex;align-items:flex-start;gap:14px;padding:10px 0;}',
      '.qqb-qrImg{width:180px;height:180px;image-rendering:pixelated;background:#fff;padding:6px;border-radius:8px;',
      'border:.5px solid var(--dsw-alias-border-l1);}',
      '.qqb-in--narrow{width:110px;}',
    ].join('');

    /** Solid colour for a connection state. */
    function stateColor(state) {
      if (state === 'ok') return 'var(--dsw-alias-state-success-primary)';
      if (state === 'warn') return 'var(--dsw-alias-state-warn-primary)';
      if (state === 'error') return 'var(--dsw-alias-state-error-primary)';
      return 'var(--dsw-alias-state-idle-primary)';
    }

    /**
     * Reach the Host bridge through whatever this build exposes.
     *
     * The dynamic client ctx is a whitelisting Proxy: reading an undeclared or
     * absent `ctx.<service>` REJECTS, while `ctx.get(name)` returns undefined —
     * the runner's own docs say "Prefer ctx.get(name) with an undefined check".
     * We therefore probe with `get` and never touch a throwing accessor.
     */
    function resolveAccess(ctx) {
      const probes = [];
      let connection = null;
      if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') {
        probes.push('ctx.get 不可用');
        return { connection, probes };
      }
      try {
        const value = ctx.get('connection');
        probes.push(`connection → ${value === null || value === undefined ? '无' : typeof value}`);
        if (value !== null && value !== undefined) {
          connection = value;
          try {
            probes.push(`connection 键：${Object.keys(value).join('、') || '（无）'}`);
          } catch {
            probes.push('connection 键：读不到');
          }
          try {
            const rpc = value.rpc;
            probes.push(`connection.rpc → ${rpc === null || rpc === undefined ? '无' : typeof rpc}`);
            if (rpc !== null && rpc !== undefined && typeof rpc === 'object') {
              probes.push(`rpc 键：${Object.keys(rpc).join('、') || '（无）'}`);
            }
          } catch (error) {
            probes.push(`读 connection.rpc 抛错：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        probes.push(`ctx.get('connection') 抛错：${error instanceof Error ? error.message : String(error)}`);
      }
      if (connection === null) {
        const found = [];
        for (const name of ['remote', 'api', 'host', 'transport', 'rpc', 'slots', 'theme', 'timer', 'sessions', 'workspaces', 'layout', 'locale', 'uiWorkspace']) {
          try {
            const value = ctx.get(name);
            if (value !== undefined && value !== null) found.push(name);
          } catch {
            // A throwing probe tells us nothing useful; skip it.
          }
        }
        probes.push(`可用服务：${found.length > 0 ? found.join('、') : '（一个都没探到）'}`);
      }
      return { connection, probes };
    }

    /** Bind `connection.rpc.call` without ever letting a getter throw. */
    function rpcCallOf(connection) {
      if (connection === null || connection === undefined) return { call: null, why: 'connection 为 undefined' };
      try {
        const rpc = connection.rpc;
        if (rpc === undefined || rpc === null) return { call: null, why: 'connection.rpc 为 undefined' };
        if (typeof rpc.call !== 'function') return { call: null, why: 'connection.rpc.call 不是函数' };
        return { call: rpc.call.bind(rpc), why: '' };
      } catch (error) {
        return { call: null, why: `读 connection.rpc 抛错：${error instanceof Error ? error.message : String(error)}` };
      }
    }

    /** Fallback transport: our own prefix route at the same path. */
    async function plainCall(endpoint, payload, errors) {
      const doFetch = globalThis.fetch;
      if (typeof doFetch !== 'function') {
        errors.push('兜底：环境里没有 fetch');
        return null;
      }
      try {
        const response = await doFetch(`${CHANNEL}/${endpoint}`.slice(1), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, payload: payload ?? {} }),
        });
        if (!response.ok) {
          errors.push(`兜底：HTTP ${response.status}`);
          return null;
        }
        const result = await response.json();
        if (result !== null && result !== undefined && result.ok === true) return result.value;
        errors.push(`兜底：${JSON.stringify(result?.error ?? result)}`);
        return null;
      } catch (error) {
        errors.push(`兜底：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }

    /**
     * The data path: Connection RPC first, self-registered route second.
     *
     * Everything that `request` closes over must be identity-stable, or the
     * `useEffect` below re-runs on every render and the page thrashes: `rpc.call`
     * is bound fresh each time, so it is memoized per resolved connection. That
     * loop made every edit snap back to the Host value.
     */
    function useBridge(ctx) {
      const access = useMemo(() => resolveAccess(ctx), [ctx]);
      const bound = useMemo(() => rpcCallOf(access.connection), [access]);
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const { call, why } = bound;

      const request = useCallback(async (endpoint, payload) => {
        setBusy(true);
        const errors = [];
        if (call !== null) {
          try {
            const result = await call(CHANNEL, endpoint, payload ?? {});
            if (result !== null && result !== undefined && result.ok === true) {
              setData(result.value);
              setError(null);
              setBusy(false);
              return;
            }
            if (result !== null && result !== undefined && result.ok === false) {
              let detail;
              try {
                detail = JSON.stringify(result.error);
              } catch {
                detail = String(result.error);
              }
              setError(`${endpoint} 被拒绝：${detail}`);
              setBusy(false);
              return;
            }
            errors.push('RPC：响应为空');
          } catch (cause) {
            errors.push(`RPC：${cause instanceof Error ? cause.message : String(cause)}`);
          }
        } else {
          errors.push(`RPC 不可用：${why}`);
        }

        const viaFallback = await plainCall(endpoint, payload, errors);
        if (viaFallback !== null) {
          setData(viaFallback);
          setError(null);
        } else {
          setError(`无法读取 QQ 桥状态（${errors.join('；')}）`);
        }
        setBusy(false);
      }, [call, why]);

      useEffect(() => { void request('status'); }, [request]);

      // Read-only endpoint fetch that must NOT clobber the page state.
      const fetchValue = useCallback(async (endpoint, payload) => {
        if (call !== null) {
          try {
            const result = await call(CHANNEL, endpoint, payload ?? {});
            if (result !== null && result !== undefined && result.ok === true) return result.value;
            if (result !== null && result !== undefined && result.ok === false) return null;
          } catch {
            // Fall through to the plain route.
          }
        }
        const errors = [];
        return plainCall(endpoint, payload, errors);
      }, [call]);

      return { data, busy, error, request, fetchValue, probes: access.probes };
    }

    /** One settings row: label + description on the left, controls on the right. */
    function Row(props) {
      return h('div', { className: 'qqb-row' }, [
        h('div', { className: 'qqb-text', key: 't' }, [
          h('div', { className: 'qqb-title', key: 'ti' }, props.title),
          props.desc ? h('div', { className: 'qqb-desc', key: 'de' }, props.desc) : null,
        ]),
        h('div', { className: 'qqb-ctl', key: 'c' }, props.children),
      ]);
    }

    /** Static text row. */
    function InfoRow(props) {
      return h(Row, { title: props.title, desc: props.desc },
        h('span', { className: 'qqb-val' }, props.value));
    }

    /** Connection + identity summary. */
    function StatusBlock(props) {
      const state = props.data;
      if (state === null) return h('div', { className: 'qqb-muted' }, '读取中…');
      const onebot = state.onebot ?? {};
      const server = state.server ?? {};
      const stats = state.stats ?? {};
      const connected = onebot.connected === true;
      const healthy = connected && onebot.ok === true;
      return h('div', null, [
        h('div', { className: 'qqb-h', key: 'h1' }, '连接'),
        h(Row, {
          key: 'conn',
          title: 'OneBot 连接',
          desc: onebot.error ? String(onebot.error) : String(onebot.baseUrl ?? ''),
        }, h('span', { className: 'qqb-val' }, [
          h('span', { key: 'd', className: 'qqb-dot', style: { background: stateColor(healthy ? 'ok' : connected ? 'warn' : 'error') } }),
          h('span', { key: 'v' }, healthy ? '正常' : connected ? '已连接但探测失败' : '未连接'),
        ])),
        h(InfoRow, {
          key: 'self',
          title: '登录 QQ',
          value: state.self?.userId
            ? `${state.self.userId}${state.self.nickname ? `（${state.self.nickname}）` : ''}`
            : '（未获取）',
        }),
        h(InfoRow, {
          key: 'report',
          title: '事件上报地址',
          desc: server.listening === true ? '本机上报入口正在监听' : '未监听',
          value: String(server.reportUrl ?? '—'),
        }),
        h(InfoRow, {
          key: 'secret',
          title: '上报签名校验',
          desc: '在 bundle patch 的 reportSecret 里配置',
          value: server.secret === true ? '已开启' : '未开启',
        }),
        h(InfoRow, { key: 'dataDir', title: '状态文件目录', value: String(state.dataDir ?? '—') }),

        h('div', { className: 'qqb-h', key: 'h2' }, '统计'),
        h(InfoRow, {
          key: 'cnt',
          title: '消息与回复',
          value: `群 ${stats.groupMessages ?? 0} · 私信 ${stats.privateMessages ?? 0} · 回复 ${stats.repliesSent ?? 0} · 轮次 ${stats.turnsStarted ?? 0}`,
        }),
        h(InfoRow, {
          key: 'srv',
          title: '上报入口',
          desc: '收 / 拒（签名不合）/ 格式错',
          value: `${server.stats?.received ?? 0} / ${server.stats?.rejected ?? 0} / ${server.stats?.malformed ?? 0}`,
        }),
        h(InfoRow, {
          key: 'dry',
          title: '试运行（dryRun）',
          desc: '打开后所有要发出的消息只写日志',
          value: state.dryRun === true ? '开' : '关',
        }),

        h('div', { className: 'qqb-h', key: 'h3' }, '会话'),
        (state.sessions ?? []).length === 0
          ? h('div', { key: 'nosess', className: 'qqb-muted' }, '还没有活跃会话。收到第一条群消息或私信后会自动创建。')
          : h('div', { key: 'sess' }, (state.sessions ?? []).map((session) => h(InfoRow, {
            key: session.sessionId,
            title: `${session.title}${session.kind === 'remote' ? '（遥控）' : session.kind === 'group' ? '（群）' : '（私信）'}`,
            desc: `${session.sessionId}${session.lastError ? `　最近错误：${session.lastError}` : ''}`,
            value: `${session.live ? '在线' : '未启动'} · ${session.busy ? '正在回复' : '空闲'} · 待处理 ${session.pending} · 本小时 ${session.turnsThisHour} 轮`,
          }))),
      ]);
    }

    /** Writable configuration. */
    function ConfigBlock(props) {
      const config = props.data?.config ?? {};
      const overrides = props.data?.overrides ?? {};
      const busy = props.busy;
      const write = props.request;
      const [baseUrl, setBaseUrl] = useState('');
      const [token, setToken] = useState('');
      const [ownerId, setOwnerId] = useState('');
      const [turns, setTurns] = useState('');

      useEffect(() => { setBaseUrl(String(config.apiBaseUrl ?? '')); }, [config.apiBaseUrl]);
      useEffect(() => { setTurns(String(config.maxTurnsPerHour ?? '')); }, [config.maxTurnsPerHour]);

      const isOverride = (key) => overrides[key] !== undefined && overrides[key] !== null;

      return h('div', null, [
        h('div', { className: 'qqb-h', key: 'h1' }, '配置（即时生效，写入状态文件，重启后仍然有效）'),

        h(Row, {
          key: 'dryRun',
          title: '试运行 dryRun',
          desc: '打开后不会真的往 QQ 发任何消息，只把内容写进日志和工具结果。第一次调试建议先打开。',
        }, h('input', {
          type: 'checkbox',
          className: 'qqb-check',
          checked: config.dryRun === true,
          disabled: busy,
          onChange: (event) => void write('setConfig', { key: 'dryRun', value: event.target.checked }),
        })),

        h(Row, {
          key: 'api',
          title: 'OneBot API 地址',
          desc: isOverride('apiBaseUrl') ? '当前来自运行时覆盖' : '当前来自 cordis.patch.yml',
        }, [
          h('input', {
            key: 'in',
            type: 'text',
            className: 'qqb-in',
            value: baseUrl,
            disabled: busy,
            placeholder: 'http://127.0.0.1:3000',
            onChange: (event) => setBaseUrl(event.target.value),
          }),
          h('button', {
            key: 'go',
            type: 'button',
            className: 'qqb-btn qqb-btn--primary',
            disabled: busy || baseUrl.trim().length === 0,
            onClick: () => void write('setConfig', { key: 'apiBaseUrl', value: baseUrl.trim() }),
          }, '保存'),
        ]),

        h(Row, {
          key: 'token',
          title: 'Access Token',
          desc: config.accessTokenSet === true ? '已设置（不会回显）。留空保存可清除覆盖。' : '未设置。',
        }, [
          h('input', {
            key: 'in',
            type: 'password',
            className: 'qqb-in',
            value: token,
            disabled: busy,
            placeholder: config.accessTokenSet === true ? '（已设置）' : '（未设置）',
            onChange: (event) => setToken(event.target.value),
          }),
          h('button', {
            key: 'go',
            type: 'button',
            className: 'qqb-btn',
            disabled: busy,
            onClick: () => { void write('setConfig', { key: 'accessToken', value: token }); setToken(''); },
          }, token.length === 0 ? '清除' : '保存'),
        ]),

        h(Row, {
          key: 'mode',
          title: '群聊默认模式',
          desc: '单个群的设置优先于这里。仅 @ 响应 = 有人 @ 机器人才回话。',
        }, h('select', {
          className: 'qqb-sel',
          value: String(config.defaultGroupMode ?? 'mention'),
          disabled: busy,
          onChange: (event) => void write('setConfig', { key: 'defaultGroupMode', value: event.target.value }),
        }, MODES.map((mode) => h('option', { key: mode, value: mode }, MODE_LABEL[mode])))),

        h(Row, {
          key: 'others',
          title: '陌生人私信',
          desc: 'chat = 每个陌生人各自开一个 DSH 会话来聊天；ignore = 直接忽略。',
        }, h('select', {
          className: 'qqb-sel',
          value: String(config.privateFromOthers ?? 'ignore'),
          disabled: busy,
          onChange: (event) => void write('setConfig', { key: 'privateFromOthers', value: event.target.value }),
        }, [
          h('option', { key: 'ignore', value: 'ignore' }, '忽略'),
          h('option', { key: 'chat', value: 'chat' }, '聊天'),
        ])),

        h(Row, {
          key: 'turns',
          title: '每小时轮次上限',
          desc: '每个会话各算各的（滚动一小时）。auto 模式的群很容易跑满，跑满之后机器人会一直沉默到下一个小时；调大之前先想清楚每一轮都是一次模型调用。',
        }, [
          h('input', {
            key: 'in',
            type: 'number',
            min: 1,
            step: 1,
            className: 'qqb-in qqb-in--narrow',
            value: turns,
            disabled: busy,
            onChange: (event) => setTurns(event.target.value),
          }),
          h('button', {
            key: 'save',
            type: 'button',
            className: 'qqb-btn qqb-btn--primary',
            disabled: busy || turns === '' || String(config.maxTurnsPerHour ?? '') === turns,
            onClick: () => void write('setConfig', { key: 'maxTurnsPerHour', value: Number(turns) }),
          }, '保存'),
        ]),

        h(Row, {
          key: 'owners',
          title: '主人 QQ（可以私信遥控 DSH）',
          desc: (config.ownerIds ?? []).length === 0 ? '未配置 —— 遥控通道关闭' : '用这些号私信机器人即可下达指令',
        }, h('span', { className: 'qqb-val' }, (config.ownerIds ?? []).length === 0 ? '—' : (config.ownerIds ?? []).join('、'))),

        h('div', { key: 'owneradd', className: 'qqb-list' }, [
          h('input', {
            key: 'in',
            type: 'text',
            className: 'qqb-in',
            value: ownerId,
            disabled: busy,
            placeholder: '输入要添加的 QQ 号',
            onChange: (event) => setOwnerId(event.target.value.replace(/[^0-9]/g, '')),
          }),
          h('button', {
            key: 'add',
            type: 'button',
            className: 'qqb-btn qqb-btn--primary',
            disabled: busy || !/^\d{5,12}$/.test(ownerId),
            onClick: () => { void write('owner', { ownerId, remove: false }); setOwnerId(''); },
          }, '添加'),
          ...(config.ownerIds ?? []).map((id) => h('button', {
            key: `rm-${id}`,
            type: 'button',
            className: 'qqb-btn',
            disabled: busy,
            onClick: () => void write('owner', { ownerId: id, remove: true }),
          }, `${id} ✕`)),
        ]),
      ]);
    }

    /** One group's row: mode, plus its own persona editor. */
    function GroupCard(props) {
      const { group, busy, request } = props;
      const info = props.promptInfo ?? { prompt: '', source: 'default' };
      const [draft, setDraft] = useState(info.prompt ?? '');
      const [open, setOpen] = useState(false);
      // Re-sync when the Host value changes (a save, or a reload).
      useEffect(() => { setDraft(info.prompt ?? ''); }, [info.prompt]);
      const dirty = draft !== (info.prompt ?? '');

      return h('div', { className: 'qqb-card' }, [
        h('div', { className: 'qqb-cardHead', key: 'head' }, [
          h('div', { className: 'qqb-text', key: 'id' }, [
            h('div', { className: 'qqb-title', key: 't' }, `${group.groupId}${group.allowed ? '' : '（已被 allow/deny 过滤）'}`),
            h('div', { className: 'qqb-desc', key: 'd' },
              `模式来源：${group.source === 'runtime' ? '运行时设置' : group.source === 'config' ? 'cordis.patch.yml' : '观察到的群'}　提示词：${info.prompt ? (info.source === 'runtime' ? '本群专用（运行时）' : '本群专用（配置）') : '全局默认'}`),
          ]),
          h('div', { className: 'qqb-ctl', key: 'ctl' }, [
            h('select', {
              key: 'sel',
              className: 'qqb-sel',
              value: group.mode,
              disabled: busy,
              onChange: (event) => void request('setGroupMode', { groupId: group.groupId, mode: event.target.value }),
            }, MODES.map((mode) => h('option', { key: mode, value: mode }, MODE_LABEL[mode]))),
            h('button', {
              key: 'rst',
              type: 'button',
              className: 'qqb-btn',
              disabled: busy || group.source !== 'runtime',
              onClick: () => void request('setGroupMode', { groupId: group.groupId, mode: null }),
            }, '重置模式'),
            h('button', {
              key: 'toggle',
              type: 'button',
              className: open ? 'qqb-btn qqb-btn--primary' : 'qqb-btn',
              onClick: () => setOpen(!open),
            }, open ? '收起提示词' : '本群提示词'),
          ]),
        ]),
        open
          ? h('div', { className: 'qqb-cardBody', key: 'body' }, [
            h('textarea', {
              key: 'ta',
              className: 'qqb-ta',
              rows: 6,
              value: draft,
              disabled: busy,
              placeholder: '给这个群单独写的人设/规则。留空 = 用全局群聊人设。\n例如：这个群是同事群，说话正式一点，不要开玩笑，被问到工作以外的事就简短带过。',
              onChange: (event) => setDraft(event.target.value),
            }),
            h('div', { className: 'qqb-cardActions', key: 'act' }, [
              h('button', {
                key: 'save',
                type: 'button',
                className: 'qqb-btn qqb-btn--primary',
                disabled: busy || !dirty,
                onClick: () => void request('setGroupPrompt', { groupId: group.groupId, prompt: draft }),
              }, dirty ? '保存本群提示词' : '已保存'),
              h('button', {
                key: 'clear',
                type: 'button',
                className: 'qqb-btn',
                disabled: busy || (draft.length === 0 && (info.prompt ?? '').length === 0),
                onClick: () => { setDraft(''); void request('setGroupPrompt', { groupId: group.groupId, prompt: '' }); },
              }, '清除本群提示词'),
              h('span', { key: 'hint', className: 'qqb-desc' }, `${draft.length} 字　下一条消息生效`),
            ]),
          ])
          : null,
      ]);
    }

    /** Per-group answering mode and persona. */
    function GroupsBlock(props) {
      const groups = props.data?.groups ?? [];
      const prompts = props.data?.groupPrompts ?? {};
      const busy = props.busy;
      return h('div', null, [
        h('div', { className: 'qqb-h', key: 'h' }, '群（模式与专用提示词）'),
        groups.length === 0
          ? h('div', { className: 'qqb-muted', key: 'e' }, '还没见过任何群。把机器人拉进群并 @ 它一次，这里就会出现。')
          : h('div', { key: 'list' }, groups.map((group) => h(GroupCard, {
            key: group.groupId,
            group,
            promptInfo: prompts[group.groupId],
            busy,
            request: props.request,
          }))),
        h('div', { className: 'qqb-muted', key: 'hint' },
          '提示词只在那个群生效，替换掉全局群聊人设；"回复方式"那条规则仍然由插件追加，不会被覆盖掉。'),
      ]);
    }

    /**
     * Login state, plus the QR to scan when the client is logged out.
     *
     * The OneBot client runs with a hidden window, so this page is the only
     * place the login QR can be shown.
     */
    function LoginBlock(props) {
      const { busy } = props;
      const [info, setInfo] = useState(null);
      const load = useCallback(async () => { setInfo(await props.loadLogin()); }, [props.loadLogin]);
      useEffect(() => { void load(); }, [load]);

      const online = info?.state === 'online';
      return h('div', null, [
        h('div', { className: 'qqb-h', key: 'h' }, '登录'),
        h(Row, {
          key: 'state',
          title: online ? '已登录' : (info === null ? '读取中…' : '未登录'),
          desc: online
            ? `${info.nickname ?? ''}（${info.userId ?? '?'}）　${info.apiBaseUrl ?? ''}`
            : (info === null ? '正在向 OneBot 查询…' : (info.probeError ?? 'OneBot 没有返回登录信息。')),
        }, h('button', {
          key: 'refresh',
          type: 'button',
          className: 'qqb-btn',
          disabled: busy,
          onClick: () => { setInfo(null); void load(); },
        }, '刷新')),
        info !== null && !online && info.qrcode
          ? h('div', { className: 'qqb-qr', key: 'qr' }, [
            h('img', { key: 'img', src: info.qrcode, alt: '登录二维码', className: 'qqb-qrImg' }),
            h('div', { className: 'qqb-desc', key: 'd' },
              `用手机 QQ 扫这个码登录。登录成功后这里会自动变成「已登录」。\n二维码文件：${info.qrcodePath}${info.modifiedAt ? `（更新于 ${new Date(info.modifiedAt).toLocaleString('zh-CN', { hour12: false })}）` : ''}`),
          ])
          : null,
        info !== null && !online && !info.qrcode
          ? h('div', { className: 'qqb-err', key: 'err' }, info.error ?? '现在没有可用的二维码。')
          : null,
      ]);
    }

    /** Where the owner's private messages land, and the sticker folder. */
    function RemoteBlock(props) {
      const { data, busy, request } = props;
      const [list, setList] = useState(null);
      const current = data?.remoteSessionId ?? '';
      const target = data?.remoteTarget ?? null;

      const load = useCallback(async () => {
        setList(await props.loadSessions());
      }, [props.loadSessions]);
      // Load on open: the owner should not have to click before the sessions
      // they can route to become visible.
      useEffect(() => { void load(); }, [load]);
      const sessions = list?.sessions ?? [];
      const loadError = list?.error ?? '';

      return h('div', null, [
        h('div', { className: 'qqb-h', key: 'h' }, '私信遥控'),
        h(Row, {
          key: 'target',
          title: '指令路由到哪个会话',
          desc: target === null
            ? `当前：插件自带的专用会话 ${current}`
            : `当前：${target.label}`,
        }, [
          h('button', {
            key: 'list',
            type: 'button',
            className: 'qqb-btn',
            disabled: busy,
            onClick: () => { setList(null); void load(); },
          }, '刷新会话列表'),
          h('button', {
            key: 'back',
            type: 'button',
            className: 'qqb-btn',
            disabled: busy || target === null,
            onClick: () => void request('setRemoteTarget', { sessionId: 'off' }),
          }, '回到专用会话'),
        ]),
        loadError.length > 0
          ? h('div', { className: 'qqb-err', key: 'err' }, loadError)
          : null,
        list === null
          ? h('div', { className: 'qqb-muted', key: 'loading' }, '正在读取会话列表…')
          : h('div', { className: 'qqb-picker', key: 'picker' }, [
            h('div', { className: 'qqb-desc', key: 'n' }, `最近 ${sessions.length} 个会话（最新在前），点一下就切过去：`),
            ...sessions.map((session) => h('button', {
              key: session.sessionId,
              type: 'button',
              className: session.sessionId === current ? 'qqb-btn qqb-btn--primary' : 'qqb-btn',
              disabled: busy,
              title: session.sessionId,
              onClick: () => void request('setRemoteTarget', { sessionId: session.sessionId }),
            }, `${session.title ?? '（无标题）'}${session.live ? ' ·在线' : ''}`)),
          ]),
        h(Row, {
          key: 'new',
          title: '开一个新的遥控会话',
          desc: '下次私信会进一个全新的会话，和现有对话完全隔离。',
        }, h('button', {
          key: 'go',
          type: 'button',
          className: 'qqb-btn',
          disabled: busy,
          onClick: () => void request('newRemoteSession', {}),
        }, '新建')),
        h(InfoRow, {
          key: 'sticker',
          title: '表情库目录',
          desc: '把表情图片丢进这个文件夹，机器人就能用 qq_sticker 发送；支持 png / jpg / jpeg / gif / webp / bmp。',
          value: data?.stickers?.enabled === false ? '已在配置里关闭' : String(data?.stickers?.dir ?? '—'),
        }),
      ]);
    }

    /** The settings page itself. */
    function QQBotPage(props) {
      const ctx = props?.ctx ?? null;
      const close = props?.close;
      // `ctx` is carried explicitly by the wrapper below, because the slot
      // registration's declared `inject` face is composed at render time and a
      // throwing accessor there is swallowed by the slot layer.
      const { data, busy, error, request, fetchValue, probes } = useBridge(ctx);
      const loadSessions = useCallback(async () => {
        const value = await fetchValue('sessions', { limit: 40 });
        if (value === null || value === undefined) {
          return { sessions: [], error: '拿不到会话列表：RPC 和兜底通道都失败了（看页面上方的「探测」那行）。' };
        }
        if (!Array.isArray(value.sessions)) return { sessions: [], error: '会话列表的返回格式不对。' };
        if (value.sessions.length === 0) return { sessions: [], error: '这个 profile 里读不到任何会话记录。' };
        return { sessions: value.sessions, error: '' };
      }, [fetchValue]);
      const loadLogin = useCallback(async () => {
        const value = await fetchValue('login', {});
        if (value === null || value === undefined) return { state: 'unknown', error: '拿不到登录状态。' };
        return value;
      }, [fetchValue]);

      return h(React.Fragment, null, [
        h('style', { key: 'css', 'data-plugin': 'dsh-qq-bridge' }, CSS),
        h('div', { className: 'qqb-root', key: 'body' }, [
          h('div', { className: 'qqb-head', key: 'head' }, [
            h('div', { key: 't' }, [
              h('div', { className: 'qqb-name', key: 'n' }, 'QQ-bot'),
              h('div', { className: 'qqb-desc', key: 'd' }, 'OneBot / NapCat 桥接的状态与配置'),
            ]),
            h('div', { className: 'qqb-ctl', key: 'a' }, [
              h('button', {
                key: 'p',
                type: 'button',
                className: 'qqb-btn',
                disabled: busy,
                onClick: () => void request('probe'),
              }, busy ? '处理中…' : '重新探测'),
              h('button', {
                key: 'r',
                type: 'button',
                className: 'qqb-btn',
                disabled: busy,
                onClick: () => void request('status'),
              }, '刷新'),
              typeof close === 'function'
                ? h('button', { key: 'c', type: 'button', className: 'qqb-btn', onClick: () => close() }, '关闭')
                : null,
            ]),
          ]),
          error ? h('div', { className: 'qqb-err', key: 'err' }, error) : null,
          error && probes.length > 0
            ? h('div', { className: 'qqb-muted', key: 'probes' }, `探测：${probes.join('；')}`)
            : null,
          h(StatusBlock, { key: 'st', data }),
          h(ConfigBlock, { key: 'cfg', data, busy, request }),
          h(LoginBlock, { key: 'login', busy, loadLogin }),
          h(RemoteBlock, { key: 'remote', data, busy, request, loadSessions }),
          h(GroupsBlock, { key: 'grp', data, busy, request }),
        ]),
      ]);
    }

    const inject = ['slots', 'connection'];

    /** Register the page into the settings panel. */
    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'qq-bot',
          order: 50,
          label: () => 'QQ-bot',
          inject: () => ({ connection: ctx.connection }),
        }, function QQBotSection(props) {
          return h(QQBotPage, { ctx, connection: props?.connection, close: props?.close });
        }));
      } catch (error) {
        // A failing registration must not take the other client plugins down —
        // make it loud in the console instead of silent.
        console.error('[dsh-qq-bridge] 注册 QQ-bot 设置页失败：', error);
      }
    }

    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});

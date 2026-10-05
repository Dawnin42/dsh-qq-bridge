/**
 * Offline render test for the Web client half (`lib/client.js`).
 *
 * There is no browser and no `react` in this environment, so this file ships a
 * miniature React (hooks + re-render loop) good enough to execute the real
 * component tree against real `pageState()` data. It catches what a syntax
 * check cannot: undefined references during render, bad prop access, and a
 * broken write path.
 *
 * It is NOT a substitute for looking at the page — styling and layout still
 * need a browser.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

import { createRpcHandler, pageState } from '../lib/rpc.js';
import { cleanupAll, makeBridge } from './harness.mjs';

after(async () => {
  await cleanupAll();
});

// Hook state is keyed by component position, so it must not leak between tests.
// (The client module itself stays imported: ESM caches it, and re-importing
// would not re-run the loader call.)
beforeEach(() => {
  hooks.clear();
});

// ---------------------------------------------------------------- mini React

/** Elements produced by the mini `createElement`. */
function isElement(value) {
  return value !== null && typeof value === 'object' && value.__el === true;
}

/** The one Fragment identity the mini React and the renderer share. */
const FRAGMENT = Symbol('Fragment');

/** Hook storage: `${ComponentName}#${n}` -> { slots, cursor }. */
let hooks = new Map();
/** Host elements collected during the current pass. */
let hostElements = [];
let invocationCounts = new Map();
let currentStore = null;
let changedDuringPass = false;
let pendingEffects = [];

function createElement(type, props, ...children) {
  const next = { ...(props ?? {}) };
  if (children.length === 1) next.children = children[0];
  else if (children.length > 1) next.children = children;
  return { __el: true, type, props: next };
}

function createMiniReact() {
  const React = {
    createElement,
    Fragment: FRAGMENT,
    useState(initial) {
      const store = currentStore;
      const index = store.cursor++;
      if (!(index in store.slots)) {
        store.slots[index] = typeof initial === 'function' ? initial() : initial;
      }
      const setter = (value) => {
        const next = typeof value === 'function' ? value(store.slots[index]) : value;
        if (next !== store.slots[index]) {
          store.slots[index] = next;
          changedDuringPass = true;
        }
      };
      return [store.slots[index], setter];
    },
    // Deps are honoured like real React: ignoring them hid an infinite
    // render/refetch loop that made the Host's values snap back on every edit.
    useCallback(fn, deps) {
      const store = currentStore;
      const index = store.cursor++;
      const previous = store.slots[index];
      const same = previous !== undefined
        && Array.isArray(deps)
        && Array.isArray(previous.deps)
        && deps.length === previous.deps.length
        && deps.every((value, at) => Object.is(value, previous.deps[at]));
      if (same) return previous.fn;
      store.slots[index] = { deps, fn };
      return fn;
    },
    useMemo(factory, deps) {
      const store = currentStore;
      const index = store.cursor++;
      const previous = store.slots[index];
      const same = previous !== undefined
        && Array.isArray(deps)
        && Array.isArray(previous.deps)
        && deps.length === previous.deps.length
        && deps.every((value, at) => Object.is(value, previous.deps[at]));
      if (same) return previous.value;
      const value = factory();
      store.slots[index] = { deps, value };
      return value;
    },
    useEffect(fn, deps) {
      const store = currentStore;
      const index = store.cursor++;
      const previous = store.slots[index];
      const same = previous !== undefined
        && Array.isArray(deps)
        && Array.isArray(previous)
        && deps.length === previous.length
        && deps.every((value, at) => Object.is(value, previous[at]));
      if (same) return;
      store.slots[index] = deps;
      pendingEffects.push(fn);
    },
  };
  return React;
}

/** Render one node, returning its text content. */
function renderNode(node, key) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child, at) => renderNode(child, `${key}.${at}`)).join('');
  if (!isElement(node)) return '';

  const { type, props } = node;

  if (typeof type === 'function') {
    const name = type.name || 'Anonymous';
    const nth = (invocationCounts.get(name) ?? 0) + 1;
    invocationCounts.set(name, nth);
    const instanceKey = `${name}#${nth}`;
    let store = hooks.get(instanceKey);
    if (store === undefined) {
      store = { slots: [], cursor: 0 };
      hooks.set(instanceKey, store);
    }
    store.cursor = 0;
    const previous = currentStore;
    currentStore = store;
    let out;
    try {
      out = type(props);
    } finally {
      currentStore = previous;
    }
    return renderNode(out, `${instanceKey}|`);
  }

  if (type === FRAGMENT) return renderNode(props.children, `${key}f`);
  hostElements.push({ type, props });
  return renderNode(props.children, `${key}>`);
}

/** Render to text, running effects and re-rendering until the tree settles. */
function render(element, maxPasses = 12) {
  let text = '';
  for (let pass = 0; pass < maxPasses; pass += 1) {
    changedDuringPass = false;
    invocationCounts = new Map();
    hostElements = [];
    pendingEffects = [];
    text = renderNode(element, 'root');
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      try {
        effect();
      } catch (error) {
        throw new Error(`effect 抛错：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!changedDuringPass && effects.length === 0) return text;
  }
  return text;
}

/** Find every host element matching a predicate. */
function findHost(predicate) {
  return hostElements.filter((element) => predicate(element.type, element.props));
}

// ------------------------------------------------------- module loader harness

let loaded = null;

/** Execute lib/client.js the way the browser module loader would. */
async function loadClientModule() {
  if (loaded !== null) return loaded;
  const captured = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) { captured.push(spec); },
    },
  };
  await import('../lib/client.js');
  assert.equal(captured.length, 1, 'lib/client.js 应该调用一次 __ModuleLoader__.load');
  loaded = captured[0];
  return loaded;
}

/** A fake client context whose slots.inject runs its callback immediately. */
function clientContext(connection) {
  const registered = [];
  const ctx = {
    connection,
    registered,
    // The dynamic client ctx exposes `get(name)`; the page must use it because
    // reading an absent `ctx.<service>` rejects.
    get(name) { return name === 'connection' ? connection : undefined; },
    slots: {
      inject(owner, callback) {
        const disposer = callback();
        return () => { if (typeof disposer === 'function') disposer(); };
      },
      register(options, component) {
        registered.push({ owner: 'settings.section', options, component });
        return () => {};
      },
    },
  };
  return ctx;
}

/** A connection that routes every call through the REAL Host RPC handler. */
function fakeConnection(bridge, calls) {
  const handler = createRpcHandler(bridge);
  return {
    rpc: {
      async call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload });
        return handler(endpoint, payload, null, null);
      },
    },
  };
}

/** Wait for queued microtasks so effects that awaited RPC settle. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Render, let async effects land, and re-render until the tree stops changing. */
async function renderSettled(element, rounds = 5) {
  let text = render(element);
  for (let pass = 0; pass < rounds; pass += 1) {
    await settle();
    const next = render(element);
    if (next === text) return text;
    text = next;
  }
  return text;
}

// ------------------------------------------------------------------- the tests

test('the loader spec declares the package id and a side-effect-free factory', async () => {
  const spec = await loadClientModule();
  assert.equal(spec.id, 'dsh-qq-bridge');
  assert.equal(typeof spec.factory, 'function');

  const React = createMiniReact();
  const module = spec.factory((name) => {
    assert.equal(name, 'react', '客户端半边只允许 require("react")');
    return React;
  });
  assert.equal(typeof module.apply, 'function');
  assert.deepEqual(module.inject, ['slots', 'connection']);
});

test('apply registers one page into settings.section with the right identity', async () => {
  const spec = await loadClientModule();
  const argv = [];
  const clientModule = spec.factory((name) => {
    argv.push(name);
    return createMiniReact();
  });

  const { bridge } = await makeBridge();
  const ctx = clientContext(fakeConnection(bridge, []));
  clientModule.apply(ctx);

  assert.equal(ctx.registered.length, 1);
  const entry = ctx.registered[0];
  assert.equal(entry.owner, 'settings.section');
  assert.equal(entry.options.name, 'settings.section');
  assert.equal(entry.options.id, 'qq-bot', '设置列表里的 id 必须是 qq-bot');
  assert.equal(typeof entry.options.label, 'function');
  assert.equal(entry.options.label(), 'QQ-bot', '导航里显示的名字');
  assert.equal(typeof entry.component, 'function');
  assert.deepEqual(argv, ['react']);
});

test('the page renders the live status and every configuration control', async () => {
  const spec = await loadClientModule();
  const clientModule = spec.factory(() => createMiniReact());
  const { bridge } = await makeBridge({ config: { ownerIds: ['20001', '123456789'] } });
  const calls = [];
  const ctx = clientContext(fakeConnection(bridge, calls));
  clientModule.apply(ctx);
  const Page = ctx.registered[0].component;

  const text = await renderSettled(createElement(Page, { ctx }));

  // 头部与状态
  assert.match(text, /QQ-bot/);
  assert.match(text, /OneBot \/ NapCat 桥接的状态与配置/);
  assert.match(text, /登录 QQ/);
  assert.match(text, /事件上报地址/);
  assert.ok(text.includes(String(pageState(bridge).server.reportUrl)), '应显示真实上报地址');
  assert.match(text, /状态文件目录/);
  assert.match(text, /消息与回复/);
  assert.match(text, /试运行（dryRun）/);
  // 配置
  assert.match(text, /OneBot API 地址/);
  assert.match(text, /Access Token/);
  assert.match(text, /群聊默认模式/);
  assert.match(text, /陌生人私信/);
  assert.match(text, /主人 QQ/);
  assert.ok(text.includes('20001、123456789'), '应列出主人 QQ');
  assert.match(text, /还没有活跃会话|会话/);
  // 群区块
  assert.match(text, /还没见过任何群|群（模式与专用提示词）/);
  // 打开页面就把三件事拉齐：状态、登录、可路由的会话（会话列表不再需要先点一下）
  assert.deepEqual(calls.map((call) => call.endpoint), ['status', 'login', 'sessions']);
  assert.equal(calls[0].channel, '/qq-bridge');
});

test('the controls send the expected setConfig / owner / setGroupMode calls', async () => {
  const spec = await loadClientModule();
  const clientModule = spec.factory(() => createMiniReact());
  const { bridge } = await makeBridge({ config: { groups: { 11111: 'auto' } } });
  const calls = [];
  const ctx = clientContext(fakeConnection(bridge, calls));
  clientModule.apply(ctx);
  const Page = ctx.registered[0].component;

  await renderSettled(createElement(Page, { ctx }));
  assert.equal(bridge.config.dryRun, false);

  // dryRun 开关
  const checkbox = findHost((type, props) => type === 'input' && props.type === 'checkbox')[0];
  assert.ok(checkbox, '应该有 dryRun 复选框');
  assert.equal(checkbox.props.checked, false);
  checkbox.props.onChange({ target: { checked: true } });
  await settle();
  assert.equal(bridge.config.dryRun, true, '勾选后应写入 dryRun 覆盖');
  assert.ok(calls.some((call) => call.endpoint === 'setConfig' && call.payload.key === 'dryRun'));

  // 群模式下拉：默认模式下拉的值是 defaultGroupMode('mention')，
  // 私信下拉是 'ignore'，只有这个群的下拉值是 'auto' —— 用它区分。
  const selects = findHost((type) => type === 'select');
  assert.ok(selects.length >= 3, `至少应有 3 个下拉框，实际 ${selects.length}`);
  const groupSelect = selects.find((element) => element.props.value === 'auto');
  assert.ok(groupSelect, '应有一个群模式下拉（值为 auto）');
  groupSelect.props.onChange({ target: { value: 'off' } });
  await settle();
  await renderSettled(createElement(Page, { ctx }));
  assert.equal(bridge.modeFor('11111'), 'off');
  assert.equal(bridge.config.defaultGroupMode, 'mention', '不应误改默认模式');
  assert.ok(calls.some((call) => call.endpoint === 'setGroupMode' && call.payload.groupId === '11111'));

  // 主人 QQ 输入框只接受数字
  const ownerInputs = findHost((type, props) => type === 'input' && String(props.placeholder ?? '').includes('QQ 号'));
  assert.equal(ownerInputs.length, 1, '应该有且只有一个"添加主人 QQ"输入框');
  ownerInputs[0].props.onChange({ target: { value: 'abc12345' } });
  await renderSettled(createElement(Page, { ctx }));
  const afterTyping = findHost((type, props) => type === 'input' && String(props.placeholder ?? '').includes('QQ 号'))[0];
  assert.equal(afterTyping.props.value, '12345', '非数字字符应被过滤');
});

test('a broken connection shows an error instead of crashing the page', async () => {
  const spec = await loadClientModule();
  const clientModule = spec.factory(() => createMiniReact());
  const connection = {
    rpc: { call: async () => ({ ok: false, error: { code: 'internal', message: '后端炸了', details: {} } }) },
  };
  const ctx = clientContext(connection);
  clientModule.apply(ctx);
  const Page = ctx.registered[0].component;

  const text = await renderSettled(createElement(Page, { ctx }));
  assert.match(text, /后端炸了/);
  assert.match(text, /QQ-bot/, '出错时页面骨架仍在');
});

test('a throwing slot registration is reported, not rethrown', async () => {
  const spec = await loadClientModule();
  const clientModule = spec.factory(() => createMiniReact());
  const ctx = {
    connection: undefined,
    slots: {
      inject() { throw new Error('slots 服务炸了'); },
      register() { return () => {}; },
    },
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.doesNotThrow(() => clientModule.apply(ctx));
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /注册 QQ-bot 设置页失败/);
});

test('the page finds the connection through ctx even when the slot layer ignores registration `inject`', async () => {
  // Regression: `dsh-client-ui-slots` has no `inject` handling, so a slot
  // registration's declared face never reaches the component. The page must
  // therefore resolve `ctx.connection` itself.
  const spec = await loadClientModule();
  const clientModule = spec.factory(() => createMiniReact());
  const { bridge } = await makeBridge({ config: { ownerIds: ['20001'] } });
  const calls = [];
  const ctx = clientContext(fakeConnection(bridge, calls));
  clientModule.apply(ctx);
  const Page = ctx.registered[0].component;

  // Render the REGISTERED component the way a slot layer would: only `close`,
  // with no `connection` prop.
  const text = await renderSettled(createElement(Page, { close() {} }));

  assert.ok(!text.includes('连接服务不可用'), '不应再报连接服务不可用');
  assert.match(text, /登录 QQ/);
  assert.match(text, /事件上报地址/);
  assert.ok(text.includes(String(pageState(bridge).server.reportUrl)));
  assert.ok(calls.some((call) => call.endpoint === 'status'), '应该真的发出了 status 请求');
});

test('the page reports exactly what the dynamic client ctx exposes', async () => {
  const spec = await loadClientModule();
  const cases = [
    { label: '服务不存在', connection: undefined, expect: ['connection → 无'] },
    { label: '服务在但缺 rpc', connection: {}, expect: ['connection → object', 'connection 键：（无）', 'connection.rpc → 无', 'connection.rpc 为 undefined'] },
  ];
  for (const item of cases) {
    hooks.clear();
    const registered = [];
    const ctx = {
      get: (name) => (name === 'connection' ? item.connection : name === 'slots' ? {} : undefined),
      slots: {
        inject: (owner, callback) => {
          const disposer = callback();
          return () => { if (typeof disposer === 'function') disposer(); };
        },
        register: (options, component) => {
          registered.push({ options, component });
          return () => {};
        },
      },
    };
    spec.factory(() => createMiniReact()).apply(ctx);
    assert.equal(registered.length, 1, '页面应该注册成功');
    const text = await renderSettled(createElement(registered[0].component, { ctx }));
    for (const fragment of item.expect) {
      assert.ok(text.includes(fragment), `${item.label} 应显示「${fragment}」，实际片段：${text.slice(-260)}`);
    }
  }
});

test('the page falls back to the plain route when the RPC transport fails', async () => {
  // The Host may mount its own prefix route when `connection.rpc.handle()` cannot
  // be used; the page must reach it without any user action.
  const spec = await loadClientModule();
  const { bridge } = await makeBridge();
  const expected = pageState(bridge);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, value: expected }; },
    };
  };
  try {
    const ctx = clientContext({
      rpc: { call: async () => { throw new Error('transport failure for /qq-bridge/status: HTTP 405'); } },
    });
    spec.factory(() => createMiniReact()).apply(ctx);
    const Page = ctx.registered[0].component;
    const text = await renderSettled(createElement(Page, { ctx }));

    assert.match(text, /登录 QQ/);
    assert.match(text, /事件上报地址/);
    assert.ok(!text.includes('无法读取 QQ 桥状态'), `不应该报错，实际：${text.slice(-200)}`);
    assert.ok(calls.length >= 1, '应该走了兜底 fetch');
    assert.equal(calls[0].url, 'qq-bridge/status');
    assert.equal(calls[0].init.method, 'POST');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('re-rendering never re-issues the status request (the edit-snaps-back loop)', async () => {
  // Regression: binding `rpc.call` fresh on every render gave `request` a new
  // identity each pass, so the effect re-ran forever and every edit was
  // immediately overwritten by a fresh Host value. The page looked read-only.
  const spec = await loadClientModule();
  const { bridge } = await makeBridge();
  const calls = [];
  const ctx = clientContext(fakeConnection(bridge, calls));
  spec.factory(() => createMiniReact()).apply(ctx);
  const Page = ctx.registered[0].component;

  await renderSettled(createElement(Page, { ctx }));
  const afterMount = calls.filter((call) => call.endpoint === 'status').length;
  assert.equal(afterMount, 1, `挂载后应只请求一次，实际 ${afterMount} 次`);

  for (let pass = 0; pass < 5; pass += 1) {
    render(createElement(Page, { ctx }));
    await settle();
  }
  const afterRerenders = calls.filter((call) => call.endpoint === 'status').length;
  assert.equal(afterRerenders, afterMount, '重复渲染不应重新请求 status');
});

test('typing into a field survives a re-render', async () => {
  const spec = await loadClientModule();
  const { bridge } = await makeBridge();
  const calls = [];
  const ctx = clientContext(fakeConnection(bridge, calls));
  spec.factory(() => createMiniReact()).apply(ctx);
  const Page = ctx.registered[0].component;

  await renderSettled(createElement(Page, { ctx }));
  const apiInput = () => findHost((type, props) => type === 'input' && props.type === 'text' && String(props.placeholder ?? '').includes('127.0.0.1'))[0];
  assert.ok(apiInput(), '应该有 OneBot 地址输入框');

  apiInput().props.onChange({ target: { value: 'http://127.0.0.1:3999' } });
  render(createElement(Page, { ctx }));
  await settle();
  assert.equal(apiInput().props.value, 'http://127.0.0.1:3999', '输入的内容不应该被刷新冲掉');
});

test('each group card edits its own persona prompt', async () => {
  const spec = await loadClientModule();
  const { bridge } = await makeBridge({ config: { groups: { 11111: 'auto' } } });
  const calls = [];
  const ctx = clientContext(fakeConnection(bridge, calls));
  spec.factory(() => createMiniReact()).apply(ctx);
  const Page = ctx.registered[0].component;

  let text = await renderSettled(createElement(Page, { ctx }));
  assert.match(text, /群（模式与专用提示词）/);
  assert.match(text, /本群提示词/);

  const toggle = findHost((type, props) => type === 'button' && String(props.children) === '本群提示词')[0];
  assert.ok(toggle, '应该有「本群提示词」按钮');
  toggle.props.onClick();
  text = await renderSettled(createElement(Page, { ctx }));

  const area = findHost((type) => type === 'textarea')[0];
  assert.ok(area, '展开后应该有文本域');
  assert.equal(area.props.value, '', '一开始为空（用全局人设）');

  area.props.onChange({ target: { value: '这个群只说短句，别开玩笑' } });
  text = await renderSettled(createElement(Page, { ctx }));
  const save = findHost((type, props) => type === 'button' && String(props.children) === '保存本群提示词')[0];
  assert.ok(save, '改了之后应该出现可点的保存');
  assert.equal(save.props.disabled, false);
  save.props.onClick();
  await settle();
  await renderSettled(createElement(Page, { ctx }));

  assert.equal(bridge.groupPrompt('11111'), '这个群只说短句，别开玩笑');
  assert.ok(calls.some((call) => call.endpoint === 'setGroupPrompt' && call.payload.groupId === '11111'));

  // 清除按钮把它退回全局人设
  const clear = findHost((type, props) => type === 'button' && String(props.children) === '清除本群提示词')[0];
  assert.ok(clear, '应该有清除按钮');
  clear.props.onClick();
  await settle();
  await renderSettled(createElement(Page, { ctx }));
  assert.equal(bridge.groupPrompt('11111'), '');
});

test('the remote block lists real sessions and routes to the one you pick', async () => {
  const spec = await loadClientModule();
  const { bridge, agents } = await makeBridge({
    config: { ownerIds: ['20001'] },
    services: {
      sessionQuery: {
        listSessions: async () => [
          { header: { id: 'session-alpha', cwd: 'D:\\work', createdAt: 2 }, live: true, persisted: true },
          { header: { id: 'session-beta', cwd: 'D:\\other', createdAt: 1 }, live: false, persisted: true },
        ],
        readTitleSnapshots: async () => [
          { sessionId: 'session-alpha', status: 'fulfilled', value: { title: { title: '甲会话' } } },
          { sessionId: 'session-beta', status: 'fulfilled', value: { title: { title: '乙会话' } } },
        ],
      },
    },
  });
  void agents;
  const calls = [];
  const ctx = clientContext(fakeConnection(bridge, calls));
  spec.factory(() => createMiniReact()).apply(ctx);
  const Page = ctx.registered[0].component;

  let text = await renderSettled(createElement(Page, { ctx }));
  assert.match(text, /私信遥控/);
  assert.match(text, /qq-remote/, '默认显示专用会话');
  assert.match(text, /表情库目录/);
  // 会话列表在打开页面时就已经列好，不用先点按钮
  assert.match(text, /甲会话/, '应该一打开就列出会话');
  assert.match(text, /乙会话/);

  const pick = findHost((type, props) => type === 'button' && String(props.children).includes('甲会话'))[0];
  assert.ok(pick, '应该能直接点中甲会话');
  pick.props.onClick();
  await settle();
  await renderSettled(createElement(Page, { ctx }));

  assert.equal(bridge.remoteSessionId(), 'session-alpha');
  assert.ok(calls.some((call) => call.endpoint === 'setRemoteTarget' && call.payload.sessionId === 'session-alpha'));
  assert.match(text, /回到专用会话/);
});

test('a missing connection service degrades with a message, not a throw', async () => {
  const spec = await loadClientModule();
  const clientModule = spec.factory(() => createMiniReact());
  const ctx = clientContext(undefined);
  clientModule.apply(ctx);
  const Page = ctx.registered[0].component;

  const text = await renderSettled(createElement(Page, { ctx }));
  assert.match(text, /无法读取 QQ 桥状态/);
});

test('the page never prints a secret even when one is configured', async () => {
  const spec = await loadClientModule();
  const clientModule = spec.factory(() => createMiniReact());
  const { bridge } = await makeBridge({ config: { accessToken: 'tok-abcdef-secret', reportSecret: 'hmac-abcdef-secret' } });
  const ctx = clientContext(fakeConnection(bridge, []));
  clientModule.apply(ctx);
  const Page = ctx.registered[0].component;

  const text = await renderSettled(createElement(Page, { ctx }));
  assert.ok(!text.includes('tok-abcdef-secret'), '渲染结果不应包含 accessToken');
  assert.ok(!text.includes('hmac-abcdef-secret'), '渲染结果不应包含 reportSecret');
  assert.match(text, /已设置（不会回显）/);
});

test('sessions and groups appear once the bridge has seen traffic', async () => {
  const spec = await loadClientModule();
  const clientModule = spec.factory(() => createMiniReact());
  const { bridge, ctx: hostCtx, agents } = await makeBridge({ config: { ownerIds: ['20001'] } });

  // 真的让 bridge 见到一条群消息和一个遥控会话
  const { groupMessageEvent, privateMessageEvent, atBot } = await import('./mock-onebot.mjs');
  bridge.selfId = '10001';
  bridge.onGroupMessage(groupMessageEvent({ message: [atBot(), { type: 'text', data: { text: '在吗' } }] }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  bridge.onPrivateMessage(privateMessageEvent({ userId: 20001, text: '看下状态' }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(agents.created.length >= 1, '应该至少建了一个会话');

  const clientCtx = clientContext(fakeConnection(bridge, []));
  clientModule.apply(clientCtx);
  const Page = clientCtx.registered[0].component;
  const text = await renderSettled(createElement(Page, { ctx: clientCtx }));
  await settle();

  assert.match(text, /群（模式与专用提示词）/);
  assert.match(text, /11111/);
  assert.match(text, /QQ 遥控|qq-remote/);
  void hostCtx;
});

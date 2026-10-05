# dsh-qq-bridge 客户端配置页（QQ-bot）实施方案

> ## ⚠️ 实施后订正（实测推翻的结论，以本节为准）
>
> 页面**已经落地并跑通**（客户端 slot 注册 + Host RPC 往返均已在活的 DSH 里验证）。以下是实施过程中被实测推翻或修正的本文档旧结论：
>
> 1. **根因不是 slot 注册的 `inject` 面被忽略。** `dsh-client-ui-slots/lib/index.js` L97/L214 确实会存储并组装注册项的 `inject`；`dsh-cordis-client-runner` 里那套会抛错的 Proxy 只作用于**动态 Cordis 包**（`cordis_define` 那一套），**不适用于** `window.__ModuleLoader__` 装载的 bundle 客户端模块（后者由 `dsh-client-modules` 当作普通 Loader 行加载，有真实 fiber ctx）。
> 2. **真正的原因是 Host 侧通道没挂上。** `connection.rpc.handle(channel, handler)` 内部是 `owner.effect(() => owner.webServer.register(route))`（`dsh-client-connection/lib/index.js` L640-657），它要用**读取 connection 服务的那个 ctx** 去拿 `webServer`。`ctx.inject(['connection'], cb)` 给出的注入 ctx 看不到 `webServer` → 抛 TypeError → 被 Cordis 吞掉 → 浏览器侧只看到一个 **HTTP 405**。**修法：`ctx.inject(['connection', 'webServer'], cb)` 同时注入两者。**
> 3. **405 不代表「路由存在但方法不对」**，它同时是「路径完全没挂」的通用回答：实测 `POST /qq-bridge/status`、`POST /dsh-session-repair/status`（已装第三方插件）与 `POST /definitely-not-a-route/status` 全都是 405；只有真正挂上的路由才会先返回 **401**（缺浏览器凭证）。排查时用这个对照。
> 4. **§4.1 的 token 清单大半不存在。** 实测 `Theme.listTokens` 只返回 14 个 token：`bg-base / bg-layer-1 / bg-layer-2 / bg-overlay / border-l1 / border-l2 / brand-primary / label-primary / label-secondary / state-error-primary / state-idle-primary / state-success-primary / state-warn-primary / specific-sidebar-fill`。最终实现只用这 14 个。
> 5. **U-3 的担心不成立**：客户端 `ctx.get('connection')` 返回的是真实服务（键为 `isLoopback / generation / state / rpc / reconnect / registerGenerationSource / start`，`rpc` 上是 `call`）。但要注意 **`ctx.get(name)` 缺服务时返回 `undefined`，而 `ctx.<服务名>` 会抛** —— 客户端代码应优先用 `ctx.get`。
> 6. 另一条兜底：本文档未提及的 `harness.handle` / `host.call` 属于动态包机制，与本插件无关。
>
> 下方原始内容保留作为调研记录，**与本节冲突处以本节为准**。

---

> 研究结论文档。**本文档不修改任何插件源码**；文中的文件骨架是「可直接抄改」的建议内容，尚未落盘。
>
> 研究对象：`<plugin-dir>`（纯 Host 插件，已以 link 方式装入 profile `web`）
>
> 目标：在 DSH Web UI 设置里新增一个名为 **QQ-bot** 的页面，展示 OneBot 连接状态 / 登录 QQ / 事件上报地址 / 各会话与群模式 / 收发统计，并能在页面上改 `apiBaseUrl`、`accessToken`、`ownerIds`、`defaultGroupMode`、`dryRun`、`privateFromOthers`。

---

## 0. 证据来源约定

| 简称 | 绝对含义 |
|---|---|
| `DSH_PKGS` | `C:\Users\<you>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` |
| `PROFILE` | `C:\Users\<you>\.dsh\profiles\web\` |
| `PLUGIN` | `<plugin-dir>\` |
| `SKILL` | `DSH_PKGS\dsh-agent-preset\skills\cordis-plugin-development\` |

所有 `L<n>` 均指该文件的行号。

### 已完成的 inspect 查询（含一次失败）

| 查询 | 结果 |
|---|---|
| `cordis_inspect_list` | 成功。Host 侧有 `Service` / `Event` / `Config` / `Tool`；Client 侧有 `Service` / `Event` / `Builtin` / `Slots` / `Theme`。 |
| host `Service.listService` | 成功（完整输出溢出到 `C:\Users\<you>\AppData\Local\Temp\dsh-spill-3HMvcd\session-2a749beb836a\9cbe16809394-cordis_inspect_query.txt`）。`settings` 在 L1356、`typert` 在目录区、`typertGateway` 在 L1848、`webServer` 在 L1917、`clientModules` 在 L264。 |
| host `Config.listConfigs` (`name: dsh-qq-bridge`) | 成功。返回 `[{"id":"include:qq-bridge","patchId":"qq-bridge","name":"dsh-qq-bridge","status":"absent"}]`。 |
| client `Slots.listSubTree`（不带 root） | **失败：连续 3 次 `timed out after 10000ms`**，提示 "Open or reconnect the Harness page, then retry"。当前没有页面在响应 client inspect。 |
| client `Theme.listTokens` / `Service.listService` | **未执行成功**（与上同一原因，client 通道无响应）。 |

> ⚠️ **由此产生的重要后果**：本文档中所有 slot key、props 形状、options 字段、主题 token，**都不是**来自 `Slots.listSubTree` 的活体快照，而是来自已安装包的源码与 `.d.ts`（下面逐条标注）。这比活体快照更稳定，但**不能替代**一次真实的 `Slots.listSubTree` 复核——见第 8 节 U-1。

另外有一个必须知道的**运行时事实**（不是猜测）：

- `PROFILE\node_modules\` 下**根本没有 `@deepseek-ai\` 这个 scope**（实测目录列表：只有 `@antfu` `@braintree` `@chevrotain` `@codemirror` `@iconify` `@lezer` `@linxin666` `@marijn` `@mermaid-js` `@mlgbnb` `@morlay` `@standard-schema` `@tt-a1i` `@types` `@upsetjs` `@xterm` 以及 5 个第三方 bundle）。
  → 证实了任务前提：**Host 半边在运行期解析不到 `@deepseek-ai/*`**，`PLUGIN\lib\index.js` L13-14 的注释也是这么写的。

---

## 1. 页面挂在哪里

### 1.1 结论

**注册到 slot `settings.section`**，`id` 用 `qq-bot`，`label` 给 `'QQ-bot'`。

它是「一个设置页 = 一个 list 条目」的唯一正确座位。设置面板的导航行**不是**硬编码的，而是 shell 从 `settings.section` 已注册条目里现算出来的。

### 1.2 证据

**（a）slot 的声明与语义** —— `DSH_PKGS\dsh-client-ui-settings\lib\types\client\contract\slots.d.ts`
- L73-77 声明 `'settings.section'`：`kind: 'list'`，`scope: 'root'`，`owner: SettingsSectionOwnerProps`。
- L62-72 的 JSDoc 逐字说明：
  > One settings page per list entry. Registrant options carry the nav identity: `id` (section key, drives `only` filtering), `order` (nav position), `label` (registrant-localized display text …). Sections render inside the panel content column.
- L154-157 给出生效的 owner props：
  ```ts
  export interface SettingsSectionOwnerProps {
      /** Close the settings panel (the shell owns the open state). */
      close: () => void;
  }
  ```

**（b）导航行确实是从 slot 条目算出来的** —— `DSH_PKGS\dsh-client-ui-settings-general\lib\client.js`
- L1017-1028：`getSnapshot()` 里 `ctx.slots.getVersion("settings.section")` → `ctx.slots.entries("settings.section").map(e => ({ id: e.options.id ?? "", order: e.options.order ?? 0, label: resolveSlotLabel(e.options.label) ?? "" })).sort((a,b) => a.order - b.order)`。
- L1032-1039：`subscribe` 同时订阅 `ctx.slots.subscribe("settings.section", …)`。

**（c）实际渲染** —— `DSH_PKGS\dsh-client-ui-settings-general\lib\client.js`
- L337：`children: active !== void 0 && renderSlot("settings.section", { close: onClose }, { only: active })`
  → 面板内容列按 `id` 过滤后只渲染当前选中的那一条，并把 `close` 作为唯一 prop 传入。

**（d）官方自带页面的注册写法**（最权威的样例）—— `DSH_PKGS\dsh-client-ui-settings-general\lib\client.js` L1171-1181：
```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "general",
    order: 0,
    label: () => t("general.nav"),
    locale: NS,
    children: { "settings.general.item": { kind: "list", scope: "root" } }
}, GeneralSection));
```

**（e）注册选项的确切类型** —— `DSH_PKGS\dsh-client-ui-slots\lib\types\index.d.ts`
- L560-583 `KindOptions`：当 `SlotMap[K]['kind']` 是 `'list'` 时，选项为 `{ id: string; order?: number; label?: SlotLabel; priority?: number }`。
- L555 `export type SlotLabel = string | (() => string)`（两处注释都说明它是「每次读取时重新求值的 thunk」，所以 `label` 直接给字符串也完全合法）。
- L597-613 `BaseOptions`：`name` / `children` / `store` / `locale` / `registrant`。
- `locale` 的语义（L604-610）：声明它会**由框架合成一个 `t` seat** 挂到组件 props 上；**若没有安装 locale face 会大声失败**（"fails loud otherwise"）→ 见 8 节 U-2。

**（f）`inject` 回调的必要性** —— `DSH_PKGS\dsh-client-ui-settings-general\lib\client.js` L937-941 逐字注释：
> Required services (cordis fiber inject). The target slots are declared by ui-settings' apply, whose activation order relative to this one is **NOT constrained**; registrations depend on their slots through `slots.inject()`.

**（g）动态注册的优先级是自动分配的** —— `DSH_PKGS\dsh-cordis-client-runner\lib\client.js` L275-280：
```js
const spec = slots.spec(slot);
let priority = options.priority;
if (spec === void 0 || spec.kind !== "chain") { priority = env.allocatePriority(); options.priority = priority; }
```
→ 因为 `settings.section` 是 `list` 而不是 `chain`，**我们自己传的 `priority` 会被运行时丢弃**，由 runner 分配。所以不要去纠结 priority，用 `order` 控制导航位置即可。

### 1.3 备选落点（结论：不推荐，但记录理由）

| 落点 | 何时才用 | 证据 |
|---|---|---|
| `settings.general.item` | 只加**一行偏好**、不要独立页面 | `contract\slots.d.ts` L120-124 + L110-119 JSDoc：`(a whole page is settings.section)`；且**不投影 `label`**，owner 不传任何 props，行内 label 得自己画 |
| `settings.plugins.tab` | 想在「插件」分区里加一个 tab | 同文件 L86-90 |
| `sidebar.panellist` / `sidebar.footer.action` | 想做成侧栏入口而非设置项 | `DSH_PKGS\dsh-client-ui-sidebar\lib\client.js` 的 slot 声明（`sidebar.panellist`、`sidebar.footer.action` 均为 list） |
| `shell.overlay` | 想做成浮层 | `SKILL\references\ui-plugin.md` L5：只有确实需要 overlay 时才用 |
| `root` / `sidebar` / `main` | **绝对不要** | `DSH_PKGS\dsh-cordis-client-runner\lib\client.js` L4304-4312、L4909-4914 明写：这些是 single 或已被占用的座位，注册进去会**把整个框架替换掉** |

### 1.4 一个重要的产品性质：设置页是模态框，不是路由

`DSH_PKGS\dsh-client-ui-settings-general\lib\client.js` L60 的 CSS 里 `.overlay{position:fixed;inset:0}`、`.panel{width:800px;height:min(800px,…)}` —— 设置面板是**覆盖层**。这意味着：

- 页面**一关就卸载**，组件内 state 会丢；
- 别把「用户正在输入的 token」放在组件 state 里当作持久来源；
- 需要跨开关保留的状态要么放回 Host（RPC），要么放 `window`/模块级变量。

另：面板宽度只有 800px，内容是窄栏（`.nav` 188px + 内容列）。表格要按窄栏设计，别做宽表。

---

## 2. Host ↔ Client 通信

### 2.1 结论

**走 `ctx.connection.rpc` 的自定义 channel**，这是本场景唯一 idiomatic 且**无需代码生成、无需 import `@deepseek-ai/*`** 的可行路径。

- Host 侧：`ctx.connection.rpc.handle(channel, handler)`（在 `ctx.inject(['connection'], …)` 里注册）
- Client 侧：`ctx.connection.rpc.call(channel, endpoint, payload)`
- `channel` 用绝对路径，例如 `'/qq-bridge'`（参考 `PROFILE\node_modules\dsh-session-repair\lib\client.js` L8 的 `const CHANNEL = '/dsh-session-repair'`）

### 2.2 为什么不是 `ctx.remote` / typert

`ctx.remote.<ns>` **确实存在且是内置插件的主流写法**，证据：
- `DSH_PKGS\dsh-api-settings-controller\lib\index.js` L12 `@Remote describe()`、L20 `@Remote update(...)`
- `DSH_PKGS\dsh-cordis-client-runner\lib\client.js` L6570-6576 `inject = ["loader","modules","slots","remote","remote.dynamicCordisRunner"]`、L6585 `ctx.remote.dynamicCordisRunner.syncInspectManifest(...)`
- 客户端消费方一律成对注入，例如 `DSH_PKGS\dsh-client-ui-settings\lib\client.js` L1503 `const inject = ["remote", "remote.settings"]`；`DSH_PKGS\dsh-api-workspace-controller\lib\client.js` L445 `const inject = ["remote", "remote.workspace"]`。

**但它对我们不可行**，因为 `remote.<ns>` 是**生成物**：

- `@Remote` 装饰器来自 typert 体系，而 Host 侧的注册/生成入口是 `ctx.typert.register(contribution)` / `getPackage` / `toJSONSchema`（见 host inspect 的 `typert` 服务目录，以及 `DSH_PKGS\dsh-typert-registry\lib\index.js`）。
- 要用它，Host 半边就得 `import` `@deepseek-ai/dsh-typert-*`——**而 `PROFILE\node_modules` 里没有 `@deepseek-ai` scope**，运行期解析必然失败。
- 另外还要一套 `declare module` 类型合并 + 客户端 schema 生成才能真正调用，对一个无构建步骤的纯 JS 插件是过重的负担。

> 所以：**typert Remote 是「一等公民」写法，但它要求你在源码树里用官方构建链编译**；profile 安装的第三方 bundle 只能走 connection RPC。

### 2.3 为什么不是 `ctx.webServer.register`

`ctx.webServer.register` 可用（`dsh-whale-widget` 就是这么干的），但**在本场景是更差的 fallback**：

**（a）它不继承任何鉴权。** `DSH_PKGS\dsh-host-webserver\lib\index.d.ts` 里 `WebRoute` 的完整形状是：
```ts
export interface WebRoute {
    kind: WebRouteKind;              // 'exact' | 'prefix'
    path: string;                    // 绝对路径，无尾斜杠
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
export type WebRouteKind = 'exact' | 'prefix';
```
注意**没有 `auth` / `methods` / `trust` 字段**——handler 直接拿到裸 `IncomingMessage`，自己拥有完整响应生命周期。对比 `DSH_PKGS\dsh-client-connection\lib\types\rpc.d.ts` L111-120 的 `ConnectionFetchRoute`（在 `/api` 之下、明确写着 "Handle one request after the physical carrier has applied its trust and authentication policy"），差别一目了然。

**（b）要自己补鉴权，而且 Host 半边只能靠 `ctx.get('connection')` 手动做：**
`rpc.d.ts` L162-175 提供了 `requestRejection(request)` 与 `admit(request)`（Host 侧 `ctx.connection` 的成员，见 host inspect `connection` 服务，spill L351）。但你要自己调用、自己处理 401/403，还要自己防 CSRF。任何漏写都是**把改 token / 改 owner 的写接口暴露出去**。

**（c）浏览器侧没有现成凭证。** 认证是 authority 绑定的 HttpOnly cookie：`DSH_PKGS\dsh-client-connection\lib\index.js` L284-285 `cookieName(authority)`、L407 `"set-cookie": sessionCookie(...)`、L429-440 `Verify the authority-bound browser cookie on a Host request`。Client 半边**拿不到也不该拿**这个 cookie 值；而 `connection.rpc.call` 走的是已鉴权的 `/api` 通道，**凭证问题根本不存在**。

**（d）URL 前缀要自己猜。** `dsh-whale-widget` L1853-1904 的 8 个路由全是**硬编码绝对路径**（`/dsh-whale/image.png`、`/dsh-whale/balance.json` …）。如果页面挂在子路径下，硬编码就会错；用相对路径又要自己拼。RPC channel 由 connection 统一承载，没有这个问题。

**结论**：只有当你需要**流式响应 / 浏览器原生下载 / 二进制资源**时才用 webServer（`SKILL\references\ui-plugin.md` 也没推荐它做数据交换）。本页面是纯 JSON 读写，**用 RPC**。

### 2.4 Host 侧确切 API

`DSH_PKGS\dsh-client-connection\lib\types\rpc.d.ts`：

```ts
// L131-138
export interface HostConnectionRpc {
    handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>;
    intercept(channel: '/api', matches: ConnectionRpcEndpointMatcher, handler: ConnectionRpcHandler): () => Promise<void>;
}

// L103
export type ConnectionRpcHandler = (
    endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerScope
) => Promise<ConnectionRpcHandlerResult>;

// L34-42
export type ConnectionRpcHandlerResult =
  | { readonly ok: true;  readonly value: unknown; readonly attachments?: readonly ConnectionRpcAttachment[] }
  | { readonly ok: false; readonly error: ConnectionRpcFailure };

// L13-17
export interface ConnectionRpcFailure { readonly code: string; readonly message: string; readonly details: object; }
```

注意两点：
1. `handle` 的 JSDoc（L132-138）写明它注册的是 **"one authenticated absolute channel prefix"** —— 鉴权是连接层给的。
2. **签名只有 2 个参数。** `PROFILE\node_modules\dsh-session-repair\lib\index.js` L404-411 现场演示并解释了历史第三个参数：
   > The third options argument is historical: on DSH <= 0.1.1 it narrowed the trust fence to loopback-only (trustedHosts = []); omitting it would widen, not narrow. DSH 0.1.2 removed the parameter (loopback trust is handled by the Connection service via its trustedHosts config), so it is ignored there.
   同一文件 L409 的写法值得照抄：`ctx.inject(['connection'], web => { if (!web.connection) return; const d = web.connection.rpc.handle(CHANNEL, handler, { authority: 'loopback' }); if (typeof d === 'function') disposeRpc = d })`。

   ⚠️ 另外注意：`handle` 返回的是 **`() => Promise<void>`**，L437-440 的销毁要 `await`。

### 2.5 Client 侧确切 API 与「能 import 什么」

`rpc.d.ts` L208-230：
```ts
export interface ClientConnectionRpc {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>;
    readonly open?: (...);   // 浏览器传输不提供 open（L219-221 明写）
}
```
返回的是**信封**（`{ok:true,value}` / `{ok:false,error}`），不是裸值——必须自己解包并抛错。

**客户端能 import 什么？** 由平台种子表决定。`DSH_PKGS\dsh-web-frontend\dist\assets\index-5SrrfWpU.js` L126 里 `staticModules` 的构造是：

```js
function rM(){return{
  react: Ef,
  "react/jsx-runtime": If,
  "react-dom": Rf,
  "react-dom/client": Df,
  "@deepseek-ai/cordis": sf,
  "@deepseek-ai/dsh-client-store": lh,
  "@deepseek-ai/dsh-client-ui-slots": hh,
  "@deepseek-ai/dsh-client-ui-primitives": sE,
  "@deepseek-ai/dsh-client-ui-dockkit": XS
}}
```

这颗种子表就是 `options.staticModules`，落进 `DSH_PKGS\dsh-client-modules\lib\client.js` L548 `this.seed = new Map(Object.entries(options.staticModules))`；`require` 的第一条分支就是 `if (this.seed.has(spec)) return this.seed.get(spec)`（L700）。

所以**技术上** `require('react')`、`require('react/jsx-runtime')`、甚至 `require('@deepseek-ai/dsh-client-ui-primitives')` 都能跑通。但：

- **按任务约束与技能要求，不要用 `@deepseek-ai/dsh-client-ui-primitives`**（`SKILL\references\ui-plugin.md` 与技能正文都要求客户端插件不 import Harness 客户端包）。本文骨架用原生元素 + 主题 token。
- **`require('react')` 是必须的**：`SKILL\references\ui-plugin.md` L9 明写 "React comes from the browser module table; no duplicate React installation, CDN script, or UMD search is needed"。

**`dsh.client.inject` 不是 import 能力**（这一点极易误解）——`DSH_PKGS\dsh-client-modules\lib\client.js` L643-661：
```js
for (const request of row.external) {           // external：先查 seed，再查图行 → 有则注册依赖
    const id = stripClientSuffix(request);
    if (this.seed.has(request) || this.loadCache.has(id)) continue;
    const dependency = this.graphRows.get(id);
    if (dependency !== void 0) await this.arriveDependency(row.id, dependency, next, visited);
}
for (const packageName of row.inject) {         // inject：只查图行；查不到就静默跳过
    const dependency = this.graphRows.get(packageName);
    if (dependency !== void 0) await this.arriveDependency(row.id, dependency, [], visited);
}
```
→ `inject` 的语义是「**如果这个包也有客户端半边并且已被挂载，就先把它加载起来**」，**不会**把名字加进模块表。所以它既是「加载顺序声明」，也是**客户端 service 的依赖声明**（见下）。

**客户端 `ctx` 是受白名单管的代理**（`DSH_PKGS\dsh-cordis-client-runner\lib\client.js` L320-358）：
- L203 CTX_VERBS = `effect` `on` `once` `provide` `timeout` `interval` `setTimeout` `setInterval` `throttle` `debounce`（后 6 个要先声明注入 `timer`，L347）
- L344 `ctx.get(name)` = 可选查找（不要求声明）
- L351 普通属性访问 = 要求已在 `inject` 里声明，否则：
  > `service "<prop>" is not declared by your plugin. Declare it on the plugin you return: { inject: ['<prop>', …], apply(ctx) { … } } — a plain \`function\` has no declaration site, so use the object form.`
- L353-355 `ctx` 是只读的，赋值直接抛错。

**`ctx.connection` 对客户端插件可得吗？可得**，两条独立证据：
1. `DSH_PKGS\dsh-client-connection\lib\client.js` L1341 `const inject = []` + L1477 `ctx.provide("connection", handle)` —— 客户端连接服务由该包提供；同包 `package.json` 的 `dsh.client` 是 `{ "inject": [], "platform": "web" }`，即它自己就是一个 web 客户端半边。
2. `DSH_PKGS\dsh-client-ui-settings-general\lib\client.js` L942-950 的 inject 数组里**同时**有 `connection` 和 `remote`，并且它 L945 就是给插件自己用的——**官方设置页自己就是这么注入 `connection` 的**。`PROFILE\node_modules\dsh-session-repair\lib\client.js` L331 也一样：`const inject = ['slots', 'connection']`。

### 2.6 推荐的数据流

```
settings.section 注册的 <QQBotPage>
        │  读：connection.rpc.call('/qq-bridge','status',{})
        │  写：connection.rpc.call('/qq-bridge','setConfig',{key,value})
        ▼
dsh-client-connection 客户端服务  ──(已鉴权 /api 通道，含 HttpOnly cookie + Origin/Host 校验)──►
        ▼
Host: ctx.connection.rpc.handle('/qq-bridge', handler)   ← 在 ctx.inject(['connection'], …) 内注册
        ▼
QqBridge 现有能力：status() / overrides() / setOverride(key,value) / setGroupMode(id,mode)
```

**Host 侧能直接复用现成能力**（无需改 bridge.js）：
- `PLUGIN\lib\bridge.js` L1206 `status()`（L1248 返回里含 `overrides`）
- `PLUGIN\lib\bridge.js` L255-273 `async setOverride(key, value)`
- `PLUGIN\lib\bridge.js` L526 `setGroupMode(groupId, mode)`
- `PLUGIN\lib\bridge.js` L276-278 `overrides()`
- `PLUGIN\lib\bridge.js` L80-88 `RUNTIME_OVERRIDE_KEYS = ['apiBaseUrl','accessToken','ownerIds','defaultGroupMode','dryRun','privateFromOthers','selfId']` —— **正好覆盖任务要求的 6 个键**（多一个 `selfId`）

⚠️ **一个必须解决的接线问题**：现在 `bridge` 实例是 `apply()` 里的**局部变量**（`PLUGIN\lib\index.js` L28 `const bridge = new QqBridge({...})`），RPC handler 拿不到它。要么把 `bridge` 提升到模块/闭包级共享，要么让 `registerTools` 的接线方式把 bridge 暴露出来——这属于实现细节，**本方案不改源码**，只指出这一处必然的改动点。

---

## 3. manifest 与加载

### 3.1 `package.json` 要改的片段

当前 `PLUGIN\package.json` L16-22 的 `exports` **没有 `./client`**，L32-36 的 `dsh` **没有 `client`**。两处都要补：

```jsonc
{
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },   // ← 新增
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "files": [
    "lib",
    "locale",
    "cordis.patch.yml",
    "README.md",
    "README.zh.md",
    "icon.svg"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {                                      // ← 新增
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-settings-general"]
    }
  }
}
```

**`dsh.client` 的确切形状**来自 `DSH_PKGS\dsh-client-modules\lib\index.js` L39-73 `parseDshClient()`：
- `platform`：**必需，字符串**；L65 `if (typeof decl.platform !== "string") throw`
- `inject`：可选 string[]（L66）
- `external`：可选 string[]（L67）
- `immediately`：可选 boolean（L68）
- **只有 `platform === "web"` 才会被接受**（L714 `if (decl === void 0 || decl.platform !== "web") return null`）

**客户端入口文件约定**：由 `exports["./client"]` 决定，**不是**硬编码路径。`DSH_PKGS\dsh-client-modules\lib\index.js`：
- L170-180 `clientExportOf()`：接受 `"./client": "./lib/client.js"` 或 `{ default: "./lib/client.js" }` 两种写法；两者都不满足就 `throw`。
- L718-719：
  ```js
  const clientRel = clientExportOf(packageName, pkg.exports);
  if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
  ```
  → **声明了 `dsh.client` 却不导 `./client` 会在插件加载时报错**，这是个硬性配对要求。

**装包位置**：`@deepseek-ai/dsh-experimental-schedule-bundle\package.json` L48-52 显示它自己只有 `dsh.bundle`，客户端半边在依赖包 `@deepseek-ai/dsh-client-ui-schedule` 里（L36）。我们是一个包同时挂 host+client，直接照 `PROFILE\node_modules\dsh-session-repair\package.json` L30-42 是最贴近的：
```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": ["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-slots"], "platform": "web" }
}
```

**`dsh.client.inject` 该写什么？** 建议写**实际存在的、已挂载的**包名：
- `@deepseek-ai/dsh-client-ui-settings-general` —— 它挂了 `settings.section` 才存在，写上可确保它先到（它 `package.json` 的 `dsh.client.platform` 是 `web`）。
- `@deepseek-ai/dsh-client-connection` —— 声明才能拿到 `ctx.connection`。
- 注意：`dsh-session-repair` 还写了 `@deepseek-ai/dsh-client-runtime`，但**实测 `DSH_PKGS` 下并没有 `dsh-client-runtime` 这个包**（包列表里只有 `dsh-cordis-client-runner`）。按 L656-659 的语义，查不到的 `inject` 名会被**静默跳过**，所以写错不会报错、但也毫无作用。别照抄这一条。

### 3.2 客户端入口文件怎么导出

形态是 **`window.__ModuleLoader__.load({ id, factory(require) { ... return module.exports } })`，返回一个 `{ inject, apply }` 对象**，用 CJS 风格 `module.exports`。

`SKILL\templates\decoration\client.js`（全文 22 行，L1-22）是规范样例：
```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Decoration() { /* … */ }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Decoration));
      },
    };
  },
});
```

`PROFILE\node_modules\dsh-session-repair\lib\client.js` L1-7 + L331-339 是同一个形态的生产级版本（它多做了 `module.exports` / `Symbol.toStringTag` 的正规化，最后 `module.exports.apply = apply; module.exports.inject = inject; return module.exports`）。

**关键点**：
- `id` 必须等于**包名**（`DSH_PKGS\dsh-client-modules\lib\index.js` L91-99 注释："a plugin bundle IS its package's client half"），所以这里是 `'dsh-qq-bridge'`。
- `factory` 是**懒执行**的（L17-20 注释："every side effect — including CSS injection — lives inside the factory closure … so load order needs no external sequencing"）。**不要在 factory 里做副作用**（`SKILL\references\ui-plugin.md` L13）。
- 返回的 `apply` 收到的是**受白名单管的 ctx 代理**（见 2.5），所以插件对象必须是**对象字面量形式**，不能是裸函数——L331 明写 "a plain `function` has no declaration site, so use the object form"。
- 必须返回 `{ inject, apply }` 两个字段；`inject` 是客户端 service 名数组，不是包名数组。

---

## 4. 主题与样式

### 4.1 可用的 `--dsw-alias-*` token

以下是从已安装包 CSS 里实际抽取的 token（去重、按用途分组）。来源：`DSH_PKGS\dsh-client-ui-theme\lib\client.js`、`DSH_PKGS\dsh-brand`、`DSH_PKGS\dsh-client-ui-settings-general\lib\client.js`。

**文字（label）**
`--dsw-alias-label-primary` · `--dsw-alias-label-secondary` · `--dsw-alias-label-tertiary` · `--dsw-alias-label-caption` · `--dsw-alias-label-dimmed` · `--dsw-alias-label-inverted`（`-primary-inverted` / `-primary-foreground`）· `--dsw-alias-label-primary-bluish` · `--dsw-alias-link`

**背景（bg）**
`--dsw-alias-bg-base` · `--dsw-alias-bg-layer-1` · `--dsw-alias-bg-layer-2` · `--dsw-alias-bg-layer-3` · `--dsw-alias-bg-overlay` · `--dsw-alias-bg-module-platform` · `--dsw-alias-bg-mask-1`（`-2` `-3`）· `--dsw-alias-bg-skeleton` · `--dsw-alias-bg-multi-select` · `--dsw-alias-settings-card-fill`

**边框（border）**
`--dsw-alias-border-l1` · `--dsw-alias-border-l2` · `--dsw-alias-border-l3` · `--dsw-alias-border-l4` · `--dsw-alias-border-inverted` · `--dsw-alias-settings-card-stroke`

**交互（hover / active）**
`--dsw-alias-interactive-bg-hover` · `--dsw-alias-interactive-bg-hover-solid` · `--dsw-alias-interactive-bg-hover-accent` · `--dsw-alias-interactive-bg-hover-danger` · `--dsw-alias-interactive-bg-active`

**状态（state）**
`--dsw-alias-state-success-primary`（`-secondary` `-tertiary`）· `--dsw-alias-state-warn-primary`（`-secondary` `-tertiary` `-label`）· `--dsw-alias-state-error-primary`（`-secondary`）· `--dsw-alias-state-idle-primary` · `--dsw-alias-state-business-primary`（`-tertiary`）

**品牌与按钮**
`--dsw-alias-brand-primary` · `--dsw-alias-brand-text` · `--dsw-alias-button-primary-fill` · `--dsw-alias-button-primary-hover` · `--dsw-alias-button-elevated-fill` · `--dsw-alias-button-contrast-fill` · `--dsw-alias-switch-thumb`

**滚动条 / 圆角 / 高度**
`--dsw-alias-scrollbar-bg-l1` / `-l2`、`--dsw-alias-scrollbar-hover-l1` / `-l2`；`--dsw-radius-xs|sm|md|lg|xl|panel`（`dsh-client-ui-theme\lib\client.js` L1142）；`--dsw-elevation-panel` / `-prominent` / `-soft`（同文件 L1160）。

> ⚠️ 上面是**从 CSS 里出现的名字**归纳的，不是 `Theme.listTokens` 的官方清单。像 `--dsw-alias-file-diff-`、`--dsw-alias-turn-trigger-`、`--dsw-alias-scrollbar-` 这种带尾随连字符的，是我抽取正则截断的产物，**不是真 token**。见 8 节 U-1。

### 4.2 表格 / 表单 / 开关的推荐做法

**照抄官方设置行的样式**，`DSH_PKGS\dsh-client-ui-settings-general\lib\client.js` L668：
```css
.Pt1bsG_row{
  border-bottom:.5px solid var(--dsw-alias-border-l2);
  justify-content:space-between; align-items:center; gap:24px;
  padding:16px 0; display:flex;
}
.Pt1bsG_title{ font-size:14px; line-height:20px; }
.Pt1bsG_description{ color:var(--dsw-alias-label-secondary); margin-top:4px; font-size:12px; line-height:18px; }
```
以及主题页的行样式（L1013）：
```css
.bVCLcG_row{ border-bottom:.5px solid var(--dsw-alias-border-l2); align-items:center; gap:8px; padding:16px 0; display:flex }
.bVCLcG_rowText{ flex-direction:column; flex:1; gap:4px; min-width:0; padding-right:48px; display:flex }
.bVCLcG_title{ color:var(--dsw-alias-label-primary); font-size:14px; font-weight:400; line-height:22px }
.bVCLcG_desc{ color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px }
```

**要点归纳：**
1. **行分隔线用 `border-bottom: .5px solid var(--dsw-alias-border-l2)`**，不要用 `<hr>`。
2. **字号固定**：标题 `14px/22px`、说明 `12px/18px`；不要用 `rem`。
3. **表格**：不要引入表格组件。用上面的 row flex 布局 + `font-variant-numeric: tabular-nums`（数字对齐，见 L1013 的 `.value`）。
4. **开关**：核心设置用的是 `--dsw-alias-switch-thumb`；由于不能用 primitives 包，建议**用原生 `<input type="checkbox">` 配 `accent-color: var(--dsw-alias-button-primary-fill)`**，比手搓 switch 更稳。
5. **输入框**：`background: var(--dsw-alias-bg-module-platform)` + `border: .5px solid var(--dsw-alias-border-l4)` + `border-radius: var(--dsw-radius-md)`，文字 `var(--dsw-alias-label-primary)`（组合参考 L1013 的 `.stepper`）。
6. **主按钮**：`background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-inverted)`，hover 用 `--dsw-alias-button-primary-hover`。
7. **状态点**：连接正常用 `--dsw-alias-state-success-primary`，异常用 `--dsw-alias-state-error-primary`，未知/未连接用 `--dsw-alias-state-idle-primary`。这也正是任务里「显示 OneBot/NapCat 连接状态」的语义映射。
8. **样式注入方式**：不要往 `document.head` 手工插 `<style>`。`SKILL\references\ui-plugin.md` L13 建议 "Component-local styles can render as React elements so unmounting removes them" —— 渲染一个 `<style>` 元素即可，或参考 `dsh-client-ui-settings-general\lib\client.js` L59-64 的 `tag.dataset.plugin = "<包名>"` 打标做法。
9. **深色主题**：只要全部用 alias token，深浅色自动跟随——`dsh-client-ui-theme` 里深色是 `body[data-ds-dark-theme]{...}` 覆盖同一批变量（L1154/L1160 可见）。**不要写死 hex 颜色**（`SKILL\references\ui-plugin.md` L13："Inherit the host theme for containers and controls"）。
10. **可见文案**：`SKILL\references\ui-plugin.md` L13 要求 "Route visible UI text through the Client locale service"。客户端 locale 服务可经 `inject: ['locale']` 拿到（`DSH_PKGS\dsh-client-locale\lib\client.js` L1526 `ctx.provide("locale", locale)`），但 `DSH_PKGS\dsh-client-locale` 用的 API 请自行核对（见 U-2）。**最省事的合规做法**：给 slot 注册项加 `locale: '<ns>'`，由框架合成 `t` seat（`DSH_PKGS\dsh-client-ui-slots\lib\types\index.d.ts` L604-610），并在 `dsh.client.inject` 里带上 locale 相关包。骨架里为降低风险先用了硬编码中文 + `label` thunk，已在注释里标明。

---

## 5. 热更新限制

### 5.1 结论

| 改动内容 | 生效方式 | 是否需要重启 DSH |
|---|---|---|
| 已挂载客户端 bundle（`lib/client.js`）的**文件内容** | **自动热重载**（stat 轮询 + SSE 推送 + 页面自动重建） | 否 |
| `package.json` 的 `dsh.client`（platform / inject / external / immediately） | **需要重启** | 是 |
| 新增/删除 bundle 行、`cordis.patch.yml` | **需要重启** | 是 |
| Host 半边 `lib/index.js` / `bridge.js` | 由 host 侧 HMR 决定（本方案未验证） | 见 U-4 |
| `exports["./client"]` 指向的**文件路径**变更 | 需要重启（元数据被缓存） | 是 |

### 5.2 证据

**（a）bundle 内容变更自动重载** —— `DSH_PKGS\dsh-client-hmr\lib\index.js`：
- L10-16 模块说明：One interval / `clientModules.rebuilt(id)` / `/plugins/events` SSE 通道广播 graph+rebuilt 帧。
- L22 `const Config = z.object({ pollIntervalMs: z.number().step(1).min(1).default(500) })` —— **默认 500ms 轮询**。
- L27-39 `bundleStat` 取 `mtimeMs` / `ctimeMs` / `size`，`sameBundleStat` 三者全等即视为未变。
- L63-77 `watchRow`：[改动时] → `publish` → L50 `ctx.clientModules.rebuilt(id)`。
- L154-156 `ctx.clientModules.onRebuilt((id, rev) => … { type: "rebuilt" })` 广播给浏览器。

**（b）Host 侧重算 rev** —— `DSH_PKGS\dsh-client-modules\lib\index.js`：
- L600-625 `rebuilt(id)`：JSDoc 逐字 "the HMR watch's registration hook — **the only entry point** through which build changes reach the graph"；"Unchanged mtime, ctime and size preserve the graph **without reading the bundle**"。
- L607-615：stat 未变则直接返回旧 rev；变了才 `readFileSync` → 新 `graphRow` → `compose()` → 通知监听者。
- L631-636 `onRebuilt(listener)`："fires only when artifact metadata changes the rev"。

**（c）浏览器侧接收** —— `DSH_PKGS\dsh-client-hmr\lib\types\client\index.d.ts` L1："Web SSE transport for page-owned client entry reconciliation and rebuilt code replacement"；`DSH_PKGS\dsh-client-hmr\lib\client.js` L23-26 解析 `rebuilt` 帧。客户端模块系统在 L785-800 `updateManifest` 里比对 `cachedRevision !== row.rev` 就 `invalidate(...)` + `removeOwnedStyles(row.id)`。
→ **无需手动刷新页面**（前提是页面开着、SSE 连着）。

**（d）为什么 manifest 变更必须重启** —— `DSH_PKGS\dsh-client-modules\lib\index.js` L118-121 逐字：
> Package metadata (including the negative "not a client package" verdict) is **cached per Loader specifier and owning-tree base URL until restart**.

即 `parseDshClient` 的结果被 `pkgMeta` 缓存（L701-729 `resolveMeta`），改 `package.json` 不会重新读取。

**（e）任务背景里提到的 watcher 条件** —— "client-plugin changes reload without a refresh only while `pnpm run dev:web` is also running"。本方案**不需要**那条路径：`dsh-client-hmr` 是运行时自带的 stat 轮询（`fs.watchFile`，见 `DSH_PKGS\dsh-client-hmr\lib\invariant.js` L11 "Live fs.watchFile pollers (this package is the composition's only stat-poll user)"），与源码树的 `dev:web` 构建 watcher 是两回事。对**已经构建好的 `lib/client.js`**，只要改动落到磁盘，500ms 内就会热重载。

⚠️ **敏感点**：`QqBridge.setOverride` 会持久化到状态文件（`PLUGIN\lib\bridge.js` L254-273）。热重载**只重建客户端半边**，不会重跑 Host `apply`。所以页面里改了 token，Host 侧的 bridge 实例必须自己在 `apply` 里重连/重读（`setOverride` 的语义请核对 U-5），而不是指望 HMR。

---

## 6. 验证方法

### 6.1 改动前后都必须做的 inspect 复核（不需要审批）

```
cordis_inspect_query  platform: host   provider: Config  method: listConfigs
                      input: {"name": "dsh-qq-bridge"}
```
改动后 `dsh-qq-bridge` 的 Config 条目应仍为 1 条（`status: "absent"` 是**正常的**——它表示该行没有导出 schemastery Config，不是「没挂载」）。
> 佐证：`Config.listConfigs(name: "dsh-session-repair")` 同样返回 `status: "absent"`，而 `dsh-session-repair` 是个正常工作的已装 bundle。`PLUGIN\lib\config.js` L4 也写明 "The plugin exports no schemastery Config on purpose"。

### 6.2 页面真的渲染出来了——在没有浏览器控制时能验到什么程度

**能验的（按可信度从高到低）：**

1. **`Slots.listSubTree` 带 `root: "settings.section"`**（首选）
   → 返回该 slot 的 catalog + occupants。如果 `dsh-qq-bridge` 出现在 occupants 里，说明**插槽注册成功**。
   ⚠️ 当前 client 通道超时（见 0 节），需要先让页面开着/重连再查。
2. **`Slots.listSubTree` 带 `root: "sidebar.settings"`**
   → 确认 `settings.section` 这个 seat 确实被 `@deepseek-ai/dsh-client-ui-settings-general` 声明了（`declaredBy` 字段会写明）。**这是本方案最关键的未验证前提**（U-1）。
3. **`Theme.listTokens`** → 拿到官方 token 清单，复核第 4 节列的 token 名，并补全我漏掉的（尤其确认 `--dsw-switch-*`/`--dsw-alias-switch-thumb` 这类开关相关 token）。
4. **`clientModules` 的 host 侧复核**（无审批）：
   - `Client.listConfigs` 之外，可查 host `Service.listService` 的 `clientModules` 条目（spill L264）确认 `graph()` / `clientPath(id)` / `rebuilt(id)` / `onRebuilt` 都在。
   - 若能看到 host 日志，`client-modules: <pkg> declares dsh.client but exports no "./client" bundle` 或 `client bundle not found` 是最典型的失败信息（`DSH_PKGS\dsh-client-modules\lib\index.js` L128-141、L718-719）。
5. **HTTP 层冒烟测试**（不需要页面，直接用 pwsh）
   `webServer` 会把合成后的 bundle 挂在 `/plugins/<entry id>/client.js`（`DSH_PKGS\dsh-client-modules\lib\index.js` L918 `const prefix = \`/plugins/${record.entry.id}/\``、L293 `/plugins/${resource.id}/client.js.map`）。
   所以可以 `Invoke-WebRequest http://127.0.0.1:3080/plugins/dsh-qq-bridge/client.js` —— 若返回 200 且是脚本内容，说明**客户端半边已被纳入 boot graph**。（注意鉴权：未带 cookie 可能 401/403，这本身就是「路由在鉴权之后」的佐证。）
6. **SSE 通道连通性** `GET /plugins/events`（`DSH_PKGS\dsh-client-hmr\lib\index.js` L4 "System SSE endpoint pushing graph/rebuilt frames (wire protocol constant)"）——能连上说明 HMR 传输在跑。

**验不到的（必须明确声明为局限）：**
- 组件**真的画出来**了、没有渲染期抛错、样式在浅色/深色下都正确、窄栏下没有溢出。
  这些只能靠**页面实际打开**。`SKILL\references\verification.md` 专门讲「没有浏览器控制时的验证限制」，实施时应读它。
- 注册成功 ≠ 用户看得见：`settings.section` 的条目要用户**打开设置面板**才会 mount（L337 `active !== void 0 && renderSlot(...)`）。
- 运行期崩溃会走 supervision 通道（`DSH_PKGS\dsh-client-ui-slots\README.md` L64："Factory crashes use the ordinary supervision channel"），console 里会有 `[cordis-client-runner] reportRenderFailure` 之类记录（L6612-6614）——**没有浏览器就看不到**。

**建议的验收顺序**：`Slots.listSubTree(root:"sidebar.settings")` → 确认 seat 存在 → `Slots.listSubTree(root:"settings.section")` → 确认 occupants 含 `dsh-qq-bridge` → 请人在页面上打开设置看一眼。

---

## 7. 可直接抄改的最小文件骨架

> 下面两段是**建议内容**，尚未写入仓库。除本文件外未创建或修改任何文件。

### 7.1 `package.json` 需要改的片段

见 3.1 节，只需两处：新增 `exports["./client"]`，新增 `dsh.client`。其余不动。

同时**不需要**改 `cordis.patch.yml`——`PLUGIN\cordis.patch.yml` L11-13 已经用 `- insert: - id: qq-bridge / name: dsh-qq-bridge` 的形式插入了 host 行，客户端半边是**附着在同一个行/包上**的（`DSH_PKGS\dsh-client-modules\lib\index.js` L713-728 `resolveMeta` 是按 Loader entry 的包名去找 `package.json`），**不需要也不应该**为客户端再加一行。

### 7.2 Host 侧：RPC 接线（示意，需接进现有 `apply`）

```js
// 在 lib/index.js 的 apply() 里追加。仍然只 import Node 内置模块：这里根本没 import 任何东西。
const RPC_CHANNEL = '/qq-bridge';

function ok(value) { return { ok: true, value }; }
function fail(code, message) { return { ok: false, error: { code, message, details: {} } }; }

// 复用 bridge 现有能力：status() / overrides() / setOverride() / setGroupMode()
function createHandler(bridge) {
  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'status':
          return ok(bridge.status());
        case 'setConfig': {
          const key = payload?.key;
          const value = payload?.value ?? null;
          if (typeof key !== 'string' || key.length === 0) return fail('bad-request', 'key is required');
          if (!RUNTIME_OVERRIDE_KEYS.includes(key)) return fail('bad-request', `key not overridable: ${key}`);
          await bridge.setOverride(key, value);          // null = 清除该 override
          return ok(bridge.status());
        }
        case 'setGroupMode': {
          const groupId = payload?.groupId;
          const mode = payload?.mode ?? null;
          if (typeof groupId !== 'string' || groupId.length === 0) return fail('bad-request', 'groupId is required');
          if (mode !== null && !GROUP_MODES.includes(mode)) return fail('bad-request', `bad mode: ${mode}`);
          bridge.setGroupMode(groupId, mode);
          return ok(bridge.status());
        }
        default:
          return fail('not-found', `unknown endpoint: ${endpoint}`);
      }
    } catch (error) {
      return fail('internal', error instanceof Error ? error.message : String(error));
    }
  };
}

// 注册（照抄 dsh-session-repair L409-411 的防御式写法）
let disposeRpc = null;
ctx.inject(['connection'], (scoped) => {
  if (!scoped.connection?.rpc?.handle) return;
  const dispose = scoped.connection.rpc.handle(RPC_CHANNEL, createHandler(bridge));
  if (typeof dispose === 'function') disposeRpc = dispose;
});
// 在原有 ctx.effect 的清理函数里补：if (disposeRpc) await disposeRpc();
```

要点：
- **不要**给 `handle` 传第三个参数（见 2.4；0.1.2 已移除，老版本才认 `{ authority: 'loopback' }`）。
- `RUNTIME_OVERRIDE_KEYS` / `GROUP_MODES` / `bridge` 都已在 `PLUGIN\lib\bridge.js` L80-88、`PLUGIN\lib\config.js` L11 定义/导出，**复用它们**，别再抄一份白名单。
- `bridge` 目前是 `apply` 的局部变量（`PLUGIN\lib\index.js` L28），必须让它对 handler 可见。

### 7.3 客户端入口 `lib/client.js`（完整示例）

含：slot 注册、数据读取、一个开关、一个文本输入框。

```js
/**
 * dsh-qq-bridge — Web 客户端半边：设置里的「QQ-bot」页。
 *
 * 形态：window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … } })
 *   - id 必须等于包名（client-modules: "a plugin bundle IS its package's client half"）
 *   - factory 内不做副作用，只返回 { inject, apply }
 *   - 只用种子表里的 react + 主题 token，不 import 任何 @deepseek-ai/* 客户端包
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const CHANNEL = '/qq-bridge';
    const NS = 'qq-bot';

    // ---- 主题 token 上的内联样式（不写死颜色，深浅色自动跟随） ----
    const css = `
      .qqb-root { display:flex; flex-direction:column; width:100%; font-size:14px; line-height:22px; color:var(--dsw-alias-label-primary); }
      .qqb-row { display:flex; align-items:center; justify-content:space-between; gap:24px; padding:16px 0; border-bottom:.5px solid var(--dsw-alias-border-l2); }
      .qqb-row:last-child { border-bottom:none; }
      .qqb-rowText { display:flex; flex-direction:column; flex:1; gap:4px; min-width:0; padding-right:48px; }
      .qqb-title { font-size:14px; line-height:22px; }
      .qqb-desc { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
      .qqb-value { font-variant-numeric:tabular-nums; }
      .qqb-control { display:inline-flex; align-items:center; gap:8px; }
      .qqb-input { box-sizing:border-box; border:.5px solid var(--dsw-alias-border-l4); border-radius:var(--dsw-radius-md);
                   background:var(--dsw-alias-bg-module-platform); color:var(--dsw-alias-label-primary);
                   font:inherit; padding:0 10px; height:36px; min-width:220px; }
      .qqb-check { width:18px; height:18px; accent-color:var(--dsw-alias-button-primary-fill); cursor:pointer; }
      .qqb-btn { border:none; border-radius:var(--dsw-radius-md); font:inherit; cursor:pointer; height:36px; padding:0 14px;
                 background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-inverted); }
      .qqb-btn:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover); }
      .qqb-btn:disabled { background:var(--dsw-alias-button-primary-dimmed); cursor:default; }
      .qqb-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
      .qqb-error { color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:18px; padding-top:8px; }
      .qqb-muted { color:var(--dsw-alias-label-caption); font-size:12px; line-height:18px; }
    `;

    // ---- 单一数据通路：connection.rpc.call ----
    function useBridge(connection) {
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      const refresh = useCallback(async () => {
        try {
          const res = await connection.rpc.call(CHANNEL, 'status', {});
          if (!res.ok) throw new Error(res.error.message);
          setStatus(res.value);
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }, [connection]);

      const write = useCallback(async (endpoint, payload) => {
        setBusy(true);
        try {
          const res = await connection.rpc.call(CHANNEL, endpoint, payload);
          if (!res.ok) throw new Error(res.error.message);
          setStatus(res.value);
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }, [connection]);

      useEffect(() => { void refresh(); }, [refresh]);
      return { status, busy, error, refresh, write };
    }

    function stateToken(state) {
      if (state === 'connected' || state === 'ok') return 'var(--dsw-alias-state-success-primary)';
      if (state === 'error' || state === 'failed') return 'var(--dsw-alias-state-error-primary)';
      return 'var(--dsw-alias-state-idle-primary)';
    }

    function Row({ title, desc, children }) {
      return h('div', { className: 'qqb-row' }, [
        h('div', { className: 'qqb-rowText', key: 't' }, [
          h('div', { className: 'qqb-title', key: 'ti' }, title),
          desc ? h('div', { className: 'qqb-desc', key: 'de' }, desc) : null,
        ]),
        h('div', { className: 'qqb-control', key: 'c' }, children),
      ]);
    }

    // 字段名全部对照 lib/bridge.js L1224-1268 的 status() 返回值，勿改。
    function connState(s) {
      if (s.onebot?.connected !== true) return 'idle';
      return s.onebot?.ok === true ? 'ok' : 'error';
    }

    /** 纯展示：不碰 Host 状态。 */
    function StatusBlock({ status }) {
      if (!status) return h('div', { className: 'qqb-muted' }, '读取中…');
      const s = status.onebot ?? {};
      const st = status.stats ?? {};
      return h('div', { className: 'qqb-root' }, [
        h(Row, {
          key: 'conn',
          title: '连接状态',
          desc: [
            s.baseUrl ? `OneBot API：${s.baseUrl}` : null,
            s.error ? `错误：${s.error}` : null,
          ].filter(Boolean).join('　') || undefined,
        }, [
          h('span', { key: 'dot', className: 'qqb-dot', style: { background: stateToken(connState(status)) } }),
          h('span', { key: 'txt', className: 'qqb-value' },
            status.onebot?.connected === true ? (status.onebot.ok === true ? '已连接' : '已连接（探测失败）') : '未连接'),
        ]),
        h(Row, { key: 'self', title: '登录 QQ 号' },
          h('span', { className: 'qqb-value' },
            status.self?.userId ? `${status.self.userId}${status.self.nickname ? `（${status.self.nickname}）` : ''}` : '（未登录）')),
        h(Row, { key: 'report', title: '事件上报地址',
          desc: status.server?.secret ? '已启用 HMAC 校验。' : '未设置 reportSecret。' },
          h('span', { className: 'qqb-value' }, String(status.server?.reportUrl ?? '—'))),
        h(Row, { key: 'stats', title: '收发统计',
          desc: `上报入口：${status.server?.stats?.received ?? 0} 收 / ${status.server?.stats?.rejected ?? 0} 拒 / ${status.server?.stats?.malformed ?? 0} 格式错` },
          h('span', { className: 'qqb-value' },
            `群 ${st.groupMessages ?? 0} · 私 ${st.privateMessages ?? 0} · 回复 ${st.repliesSent ?? 0}`)),
        h(Row, { key: 'groups', title: '群模式', desc: '来源：runtime 覆盖 / 配置 / 观察到的群。' },
          h('span', { className: 'qqb-value' },
            (status.groups ?? []).length === 0 ? '（无）'
              : (status.groups ?? []).map((g) => `${g.groupId}:${g.mode}${g.allowed ? '' : '(拒)'}`).join('　'))),
      ]);
    }

    /** 可写配置：文本输入 + 开关。 */
    function ConfigForm({ status, busy, write }) {
      const overrides = status?.overrides ?? {};
      // dryRun / apiBaseUrl 都在 status() 顶层（L1226 / L1230），没有 status.config 这一层。
      const effectiveBaseUrl = status?.onebot?.baseUrl ?? '';
      const [baseUrl, setBaseUrl] = useState('');
      const [token, setToken] = useState('');

      // 每次 Host 状态刷新后把输入框对齐到当前生效值
      useEffect(() => { setBaseUrl(String(effectiveBaseUrl)); }, [effectiveBaseUrl]);
      useEffect(() => { setToken(''); }, [overrides.accessToken]);

      const dryRun = status?.dryRun === true;

      return h('div', { className: 'qqb-root' }, [
        h(Row, {
          key: 'dryRun',
          title: 'dryRun（试运行）',
          desc: '打开后不会真的往 QQ 发消息，只把内容写进工具结果。',
        }, h('input', {
          key: 'cb', type: 'checkbox', className: 'qqb-check', checked: dryRun, disabled: busy,
          onChange: (e) => void write('setConfig', { key: 'dryRun', value: e.target.checked }),
        })),

        h(Row, {
          key: 'apiBaseUrl',
          title: 'OneBot API 地址',
          desc: overrides.apiBaseUrl ? '当前值来自运行时覆盖。' : '当前值来自 cordis.patch.yml。',
        }, [
          h('input', {
            key: 'in', type: 'text', className: 'qqb-input', value: baseUrl, disabled: busy,
            placeholder: 'http://127.0.0.1:3000',
            onChange: (e) => setBaseUrl(e.target.value),
          }),
          h('button', {
            key: 'go', type: 'button', className: 'qqb-btn', disabled: busy,
            onClick: () => void write('setConfig', { key: 'apiBaseUrl', value: baseUrl }),
          }, '保存'),
        ]),

        h(Row, {
          key: 'accessToken',
          title: 'Access Token',
          desc: '留空提交表示清除覆盖，回到配置文件里的值。',
        }, [
          h('input', {
            key: 'in', type: 'password', className: 'qqb-input', value: token, disabled: busy,
            placeholder: overrides.accessToken ? '（已设置，重新输入以替换）' : '（未设置）',
            onChange: (e) => setToken(e.target.value),
          }),
          h('button', {
            key: 'go', type: 'button', className: 'qqb-btn',
            disabled: busy || token.length === 0,
            onClick: () => void write('setConfig', { key: 'accessToken', value: token }),
          }, '保存'),
        ]),
      ]);
    }

    /** 设置面板里的一页。 */
    function QQBotSection() {
      const connection = React.useContext(ConnectionContext);
      const { status, busy, error, refresh, write } = useBridge(connection);

      // props.close 由 shell 传入（SettingsSectionOwnerProps），此处取用。
      const close = arguments[0]?.close;

      return h(React.Fragment, null, [
        h('style', { key: 'css', 'data-plugin': 'dsh-qq-bridge' }, css),
        h('div', { className: 'qqb-root', key: 'head' }, [
          h(Row, { key: 'act', title: 'QQ-bot', desc: 'OneBot / NapCat 桥接的实时状态与配置。' }, [
            h('button', { key: 'r', type: 'button', className: 'qqb-btn', disabled: busy,
              onClick: () => void refresh() }, busy ? '刷新中…' : '刷新'),
            close ? h('button', { key: 'c', type: 'button', className: 'qqb-btn',
              onClick: () => close() }, '关闭') : null,
          ]),
        ]),
        error ? h('div', { className: 'qqb-error', key: 'err' }, error) : null,
        h(StatusBlock, { key: 'st', status }),
        h(ConfigForm, { key: 'cfg', status, busy, write }),
      ]);
    }

    // connection 服务由 host 侧以 ctx.provide("connection", …) 提供（dsh-client-connection）。
    // 这里不 import 任何包，只通过 apply 收到的 ctx 使用它。
    const ConnectionContext = React.createContext(null);

    return {
      // 客户端 service 依赖：slots 必需；connection 提供 RPC。
      inject: ['slots', 'connection'],

      apply(ctx) {
        // 只注册一次；label 用 thunk，跟随语言变化时重新读取。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'qq-bot',
          order: 50,
          label: () => 'QQ-bot',
          inject: () => ({ connection: ctx.connection }),
        }, function Section(props) {
          return h(ConnectionContext.Provider, { value: props.connection },
            h(QQBotSection, props));
        }));
      },
    };
  },
});
```

**骨架里每一处「为什么这么写」的对照：**

| 写法 | 依据 |
|---|---|
| `window.__ModuleLoader__.load({ id: 'dsh-qq-bridge', factory })` | `SKILL\templates\decoration\client.js` L1-3；`PROFILE\node_modules\dsh-session-repair\lib\client.js` L1-3 |
| `require('react')`，不用 CDN/UMD | `SKILL\references\ui-plugin.md` L9 |
| 返回 `{ inject, apply }` 对象形式 | `DSH_PKGS\dsh-cordis-client-runner\lib\client.js` L331（裸函数没有声明位） |
| `inject: ['slots','connection']` | 同上 L329/L351；`dsh-client-ui-settings-general\lib\client.js` L942-950；`dsh-session-repair\lib\client.js` L331 |
| `ctx.slots.inject('settings.section', () => ctx.slots.register({...}, C))` | `SKILL\references\ui-plugin.md` L11；`dsh-client-ui-settings-general\lib\client.js` L1171-1181 |
| `id: 'qq-bot'` / `order: 50` / `label` | `DSH_PKGS\dsh-client-ui-slots\lib\types\index.d.ts` L564-569；`dsh-client-ui-settings-general\lib\client.js` L1023-1028 |
| 不传 `priority` | `dsh-cordis-client-runner\lib\client.js` L276-280（非 chain 槽会被运行时强制覆盖） |
| `inject: () => ({ connection: ctx.connection })` | `dsh-session-repair\lib\client.js` L336（同样的业务面注入写法） |
| `connection.rpc.call(CHANNEL, endpoint, payload)` + 解包 `res.ok` | `dsh-client-connection\lib\types\rpc.d.ts` L208-218、L19-25 |
| 全用 `--dsw-alias-*`，无 hex | `SKILL\references\ui-plugin.md` L13；`dsh-client-ui-theme\lib\client.js` L1154/L1160 |
| `border-bottom:.5px solid var(--dsw-alias-border-l2)` 等行样式 | `dsh-client-ui-settings-general\lib\client.js` L668、L1013 |
| `<style data-plugin="dsh-qq-bridge">` 随组件挂载/卸载 | `SKILL\references\ui-plugin.md` L13；`dsh-client-ui-settings-general\lib\client.js` L59-64 |
| 不 import `dsh-client-ui-primitives` | 任务约束 + 技能正文（尽管它在种子表里，见 2.5） |

**骨架里已知的粗糙处（实施时应修）**：
- `QQBotSection` 用 `arguments[0]?.close` 是笔误级别的写法，应改成正常的 `function Section({ close, connection })` 解构。
- 为了「一页里既显示状态又能改配置」，我用了 `React.createContext` 把 `connection` 透传两层；也可以用更简单的 prop 直传。
- 状态字段名已逐个对照源码核对：`status()` 见 `PLUGIN\lib\bridge.js` L1224-1268，`server.stats` 见 `PLUGIN\lib\onebot.js` L235 `{ received, rejected, malformed }`。骨架里的取数路径（`onebot.baseUrl` / `onebot.connected` / `onebot.ok` / `self.userId` / `server.reportUrl` / `stats.*` / `groups[].mode` / `overrides` / `dryRun`）与之一致。仍待核对的是**写入侧**，见 U-5。
- `accessToken` 属于敏感值，不应回显。骨架里只回显「是否已设置」。

---

## 8. 不确定 / 需要实测验证的点

> 下面每一条都**没有**被我证实。请勿当成事实使用。

- **U-1｜client inspect 全程不可用。**
  `Slots.listSubTree`（不带 root 与带 root）连续 3 次 `timed out after 10000ms`，`Theme.listTokens` 与 client `Service.listService` 因此未执行。本文档的 slot key / props / token 全部来自源码与 `.d.ts` 静态阅读。
  **必须实测**：页面开着时重跑 `Slots.listSubTree(root: "sidebar.settings")` 与 `(root: "settings.section")`，确认 ① seat 的 `declaredBy` 是 `@deepseek-ai/dsh-client-ui-settings-general`；② 我们的条目出现在 occupants；③ props 形状确实是 `{ close }`。

- **U-2｜`locale` 选项的行为未验证。**
  `DSH_PKGS\dsh-client-ui-slots\lib\types\index.d.ts` L604-610 警告：声明 `locale` 会合成 `t` seat，且「requires an installed locale face — fails loud otherwise」。骨架里**故意没写 `locale`**，改用 `label: () => 'QQ-bot'` 硬编码 + 组件内中文字面量。
  **必须实测**：若改用 locale，需确认客户端 locale 的注册 API（`DSH_PKGS\dsh-client-locale\lib\client.js` L1526 提供 `locale` 服务，但 `register/addLanguage/getLocale` 的**确切签名我没有读**——`dsh-session-repair\lib\client.js` L93-101 的 `svc.register(ns, dicts)` + `svc.bind(ns)` 是对着 `ctx.get('locale')` 写的，且外面包了 `try/catch`，说明连它自己都不确定）。另外 `label` thunk 是否真的会在切换语言时被重新求值，只从注释推断，未实测。

- **U-3｜`@deepseek-ai/dsh-client-connection` 是否必然已挂载。**
  它是 `dsh-web-app` 组合的一部分（`PROFILE\package.json` L14），其 `package.json` 声明了 `dsh.client.platform: "web"`，且官方设置页会 inject `connection`。但我**没有**直接验证它在 `web` profile 的 boot graph 里。
  **必须实测**：`Slots.listSubTree` 或直接请求 `/plugins/@deepseek-ai/dsh-client-connection/client.js`。若不成立，`ctx.connection` 会是 `undefined`，页面得降级（骨架没写降级分支）。

- **U-4｜Host 半边改动是否需要重启。**
  我只验证了**客户端 bundle** 的热重载链路（`dsh-client-hmr` → `clientModules.rebuilt` → SSE）。Host 插件文件的 HMR（`dsh-hmr` 服务，spill L630）**我没有读**。另外 host inspect 的 `hmr` 条目在溢出文件里被截断（含 `runExclusive` / `watchConfig` / `getOuterStack` 的残片）。

- **U-5｜`setOverride` 的语义与边界未逐字核对。**
  `status()` 的返回结构**已核对**（`PLUGIN\lib\bridge.js` L1224-1268；`server.stats` 内部字段在 `PLUGIN\lib\onebot.js` L235 `{ received, rejected, malformed }`），骨架里的取数路径与之一致。
  仍未核对的是**写入侧**：`setOverride(key, null)` 清除覆盖的确切语义（L255-273 只看到大意）；对 `accessToken` 这类敏感键是否有特殊处理；`setOverride` 与 `setGroupMode`（L526-540）在写盘失败时的行为。落地前请读这两段。

- **U-6｜`RUNTIME_OVERRIDE_KEYS` 之外是否还有需要在页面上暴露的运行时开关。**
  该数组（`PLUGIN\lib\bridge.js` L80-88）有 7 个键，任务只要 6 个（不含 `selfId`）。此外 `PLUGIN\lib\tools.js` L310-334 显示群模式与「清除覆盖」也走 `setOverride` / `setGroupMode`——群模式的写入端点我在骨架里给了 `setGroupMode`，但**它的参数校验细节没核对**。

- **U-7｜`dsh.client.inject` 的正确取值无法完全确定。**
  `PROFILE\node_modules\dsh-session-repair\package.json` L35-39 写了 `@deepseek-ai/dsh-client-runtime`，但该包**在安装目录里不存在**；按 `DSH_PKGS\dsh-client-modules\lib\client.js` L656-659 的语义，查不到会被静默忽略。
  **需要实测**：`settings.section` 这个 seat 究竟由哪个包的客户端半边声明。我从 `dsh-client-ui-settings\lib\types\client\contract\slots.d.ts` L11-12 的 `declare module '@deepseek-ai/dsh-client-ui-slots'` 推出「类型由此包声明」，而 L4-5 的注释说 shell 是 `ui-settings-general` 且它 "occupies `sidebar.settings`"——**类型声明包 ≠ 运行时声明包**，我这里有一个尚未弥合的推理缺口。落地时先不写 `inject` 或只写 `@deepseek-ai/dsh-client-ui-settings-general`，然后用 U-1 的方法验证。

- **U-8｜`/plugins/<id>/client.js` 的鉴权行为未验证。**
  `DSH_PKGS\dsh-client-modules\lib\index.js` L918/L293 给出该路径格式，但我没有实测未带 cookie 请求会得到 200 还是 401/403。第 6 节的「HTTP 冒烟测试」建议因此是**待验证的方法**，不是已验证的结论。

- **U-9｜第 4 节 token 清单的完整性。**
  列表是按正则从 CSS 文本里抽的，混入了截断伪 token（`--dsw-alias-file-diff-`、`--dsw-alias-turn-trigger-`、`--dsw-alias-scrollbar-`）。**开关相关的完整 token 集（`--dsw-switch-*`）我没有找到**，只找到 `--dsw-alias-switch-thumb`。请用 `Theme.listTokens` 复核后再定稿。

- **U-10｜`SKILL\references\verification.md` 未读。**
  技能要求「没有浏览器控制时按 `references\verification.md` 执行」。本次只读了 `ui-plugin.md` 与 `user-actions.md`（任务点名的那两个）。第 6 节的验证建议是自拟的，正式验收前应补读该文件。

---

## 9. 一句话结论

**把「QQ-bot」做成 `settings.section` 上的一个 list 条目**（`id: 'qq-bot'`、`label: 'QQ-bot'`、props 只有 `{ close }`），**数据读写走 `ctx.connection.rpc` 的自定义 channel `/qq-bridge`**（Host 用 `rpc.handle`、Client 用 `rpc.call`，两端都不需要 import 任何 `@deepseek-ai/*`），**manifest 只需在 `package.json` 补 `exports["./client"]` 与 `dsh.client: { platform: "web", inject: [...] }`**，客户端入口写成 `window.__ModuleLoader__.load({ id: 'dsh-qq-bridge', factory })` 并返回 `{ inject, apply }`。样式全部走 `--dsw-alias-*` token，抄官方设置行的 `border-bottom:.5px solid var(--dsw-alias-border-l2)` 布局。**改 `lib/client.js` 的内容会自动热重载（500ms stat 轮询 + SSE），但改 `package.json` 的 `dsh.client` 必须重启 DSH。**

# dsh-qq-bridge — DSH ⇄ QQ 桥

把本机 QQ 接进 DeepSeek Harness：**群聊可以只在你被 @ 时回话，也可以自己跟聊；私信可以让指定账号远程指挥 DSH。**

底层用 **OneBot v11** 协议，所以 NapCat、SnowLuma、Lagrange、LLOneBot 这类本机 QQ 实现都能直接用，插件本身不绑定任何一家。

---

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 群聊 @ 响应 | 有人 @ 机器人时，插件把最近的对话上下文和新消息一起交给一个 DSH 会话，由模型决定说什么 |
| 群聊自动跟聊 | 群安静一段时间后自动触发一轮，模型自己判断要不要接话；不接就什么都不发 |
| 私信遥控 | 你标记为「主人」的 QQ 私信机器人，内容作为指令送进 DSH 执行，结果自动回传到你的 QQ |
| 陌生人私信聊天 | 可选：每个陌生人各自一个 DSH 会话，用 `qq_reply` 工具回话 |
| 工具集 | 11 个 `qq_*` 工具，任何 agent 都能查群、查成员、发消息、看缓存历史、改群模式 |
| 安全开关 | 试运行（dryRun）、群白/黑名单、每群每小时轮次预算、上报签名校验、群会话工具白名单 |

每个群、每个陌生人、你的遥控通道，各自对应**一个独立的 DSH 会话**，会出现在工作区列表里，你可以直接打开看它和谁聊了什么。

---

## 快速开始

### 第 0 步：安装（已完成就不用做）

插件已经装进 `web` profile。如果需要重新安装或搬到别的 profile：

```
plugin_manager install_bundle  target = <本目录绝对路径>
```

`install_bundle` 会把它 link 进 profile 并加入 bundle 列表。

> **热重载限制**：改完插件源码后，DSH 需要**重启**才会加载新的 JS 代码（切换 bundle 开关不会换代码）。重启命令：先退出正在运行的 `dsh web`，再重新执行它。

### 第 1 步：准备一个 OneBot 实现

插件只负责「DSH 这一侧」，QQ 登录本身由本机 OneBot 实现完成。

1. 装一个 OneBot v11 实现（Windows 上最常用的是 **NapCat**；本仓库参考的 Tulpa 项目用的是 **SnowLuma**）。
2. 启动它并**扫码登录**你的 QQ 小号（建议用不常用的号，机器人会真的以这个身份发言）。
3. 记住它的登录 QQ 号。

### 第 2 步：配置 OneBot 的网络

在 OneBot 客户端的「网络配置 / 连接设置」里加两项（不同实现措辞略有差别，关键是这两个方向）：

**A. HTTP 服务端（HTTP API）** —— 让插件能调用它

| 项 | 值 |
| --- | --- |
| 主机 | `127.0.0.1` |
| 端口 | `3000`（可改，要和插件里的 `apiBaseUrl` 一致） |
| Token | 留空，或自己设一个（设了就要在插件里填一样的） |

**B. HTTP 客户端 / HTTP 上报** —— 让它把消息推给插件

| 项 | 值 |
| --- | --- |
| URL | `http://127.0.0.1:8799/onebot` |
| 消息格式 | `array` 和 `string` 都支持 |
| Secret | 可选；填了就要在插件里填一样的（插件用 HMAC-SHA1 校验 `X-Signature`，也接受 `Authorization: Bearer <secret>`） |

> 端口冲突：`8799` 被占用时插件会自动换端口，并在日志里打印实际地址。用 `qq_status` 能看到真实的「事件上报地址」。

### 第 3 步：把插件连上去

在 DSH 里直接说人话就行，agent 会调用 `qq_config`：

> 把 QQ 桥连到 `http://127.0.0.1:3000`，token 是 `abc123`，我的 QQ 是 `12345678`

等价于两次工具调用：

```
qq_config { action: "endpoint", api_base_url: "http://127.0.0.1:3000", access_token: "abc123" }
qq_config { action: "owner",    owner_id: "12345678" }
```

这两项会立刻生效并写进状态文件，重启后依然有效，**不需要改 YAML**。

如果更喜欢配置文件，就编辑本目录的 `cordis.patch.yml` 里的 `config:` 段，然后重启 DSH。

### 第 4 步：验证

```
qq_status          # 看连接状态、真实上报地址、群模式、统计
qq_client { action: "probe" }   # 主动探测一次 OneBot 连接
```

`qq_status` 里出现「OneBot：已连接」「登录 QQ：昵称(号码)」就通了。

然后在群里 @ 一下机器人（默认模式就是 `mention`），或者在 QQ 上用自己的号给机器人发一条私信。

---

## Web 配置页：QQ-bot

DSH Web 界面 → 左下角「设置」→ 左侧列表里有一页 **QQ-bot**。它通过 Connection RPC 通道 `/qq-bridge` 直接读写正在运行的插件，不需要改 YAML、不需要重启。

| 区块 | 内容 |
| --- | --- |
| 连接 | OneBot 连接状态（带状态点）、登录 QQ 号、事件上报地址、签名校验、状态文件目录 |
| 统计 | 群消息 / 私信 / 回复 / 触发轮次，以及上报入口的收 / 拒 / 格式错计数 |
| 会话 | 每个群、每个私信、遥控通道各自的会话 id、在线状态、是否正在回复、本小时已用轮次 |
| 配置 | dryRun 开关、OneBot API 地址、Access Token（**不回显**，只显示是否已设置）、群聊默认模式、陌生人私信策略 |
| 主人 QQ | 列表 + 增删，输入框只接受 5~12 位数字 |
| 群 | 每个群一张卡片：模式下拉 + **本群专用提示词**编辑器（可展开、可保存、可清除回全局） |
| 私信遥控 | 看/改指令路由到哪个会话：列出最近会话一键切换、开新会话、回到专用会话；并显示表情库目录 |

页面右上角有「重新探测」（主动调一次 `get_login_info`）和「刷新」。

### 单群专用提示词

每个群可以有自己的一套人设，替换掉全局群聊人设。三种改法，效果一样：

```
qq_group_prompt { group_id: "123456", prompt: "这个群是同事群，说话正式一点。" }
qq_group_prompt { group_id: "123456" }              # 查询
qq_group_prompt { group_id: "123456", clear: true } # 清除
```

或者写进 `cordis.patch.yml`：

```yaml
groups:
  '123456': 'auto'                     # 只设模式
  '654321':
    mode: 'mention'
    prompt: '这个群是同事群，说话正式一点，别开玩笑。'
```

只在那个群生效。**回复机制那几条规则（必须调 `qq_reply`、不要 Markdown、当前群号、当前时间）由插件继续追加**，所以写提示词不会把回复机制写坏。

### 表情包

表情库是一个文件夹（默认 `<状态文件目录>/stickers`，可以把 png / jpg / jpeg / gif / webp / bmp 丢进去；文件名就是表情名）。

```
qq_sticker { action: "list" }
qq_sticker { action: "send", target_kind: "group", target_id: "123456", sticker: "开心" }
qq_sticker { action: "send", target_kind: "private", target_id: "123456789", sticker: "face:178", text: "就这" }
```

- `sticker` 可以是：表情库里的名字、`face:<数字>`（QQ 自带表情）、图片 URL、本机图片绝对路径。
- 群里也可以直接在 `qq_reply` 里带 `sticker` 参数。
- 本地图片以 `base64://` 发送，绕开各家 OneBot 实现的路径差异。
- 单个文件上限 `stickers.maxBytes`（默认 4MB）；`stickers.enabled: false` 可整个关掉。

### 私信遥控路由到指定会话

默认情况下，主人的私信进的是插件自带的专用会话（`qq-remote`）。你可以把它改成**任意已有会话**，或者开一个新的：

```
/use              查看当前路由
/use list         列出最近会话
/use <会话 id>    切过去（那个会话没在跑的话会自动恢复）
/use new          开一个全新的会话
/use off          回到插件自带的专用会话
```

等价工具：`qq_remote { action: "list" | "use" | "new" | "off" | "status", session_id }`；页面上也有对应的选择器。

细节：**只有插件自己发起的那一轮回复才会传回 QQ**。你在 DSH 界面上手动和那个会话说话，不会把回复刷到手机上。

同一轮里**内容完全相同的 `qq_reply` 只会发出一次** —— 实测中模型偶尔会把同一句话连调三次，在群里就是刷屏；换个措辞就能再发一条。

单群提示词**改完下一条消息就生效**：保存时会把这个群的 agent 淘汰一次，下一条消息用新人格重建
（会话记录本身保留，只是重开运行时，所以没有丢历史）。如果那一刻它**正在回答**，则等这一轮答完再重建，
不会把回复掐断。

> 为什么要这么做：人格是在 agent 创建时注入的。实测确认 —— 对一个活着的会话把提示词改成
> 「只用英文回答」，下一轮回复**仍然是中文**，说明 Harness 不会每轮重新组装系统提示词。
> 所以"改完立即生效"只能靠在改动时重建一次会话来实现，而不是每轮重组装。

### 首次启用：必须重启一次 DSH

安全说明：Token 与 `reportSecret` **永远不会发送到浏览器**，页面只知道「是否已设置」；写入走的也是同一个经过鉴权的 Connection 通道。

> 客户端半边改动（`lib/client.js`）会热重载，刷新页面即可；但改动 `package.json` 里的 `dsh.client` 字段、或者改 Host 半边（`lib/bridge.js` / `lib/tools.js` / `lib/rpc.js`）都必须重启 DSH。

`package.json` 里的 `dsh.client` 是**启动时**读取并缓存的，所以第一次挂上这个页面必须重启一次：

1. 双击工作区里的 `重启DSH.bat`（自动杀进程 → 新窗口重启 → 轮询 3080 直到起来），
   或者手动在跑 `dsh web` 的窗口按 `Ctrl+C` 再重新执行 `dsh web`；
2. 刷新 http://127.0.0.1:3080 ；
3. 左下角「设置」→ 左侧列表里应出现 **QQ-bot**。

重启后可以这样确认它真的挂上了（不需要打开面板）：

```powershell
# 路由挂上后，未带浏览器凭证的请求会返回 401（而不是 405）
try { Invoke-WebRequest http://127.0.0.1:3080/qq-bridge/status -Method POST -ContentType 'application/json' -Body '{}' -UseBasicParsing }
catch { $_.Exception.Response.StatusCode.value__ }
```

- **401** = 通道已挂载（只是该请求没有浏览器凭证）—— 这是成功的信号
- **405** = 路径完全没挂上（`POST /definitely-not-a-route/status` 也是 405，可以拿它对照）

如果 401 但页面仍报错，看页面上的「探测：」那一行和浏览器控制台。

### 机器人突然不说话了？先看每小时轮次上限

每个会话有**滚动一小时**的轮次预算 `maxTurnsPerHour`（默认 120）。**跑满之后这个会话会一直沉默到下一个小时**，
`qq_status` 里能看到 `本小时轮次：30/30` 这种满额状态。这是防止 auto 模式的群无限烧模型额度的护栏，
不是故障。

两种在线调法（都不需要改 YAML、不需要重启）：

```
qq_config { action: "show" }                       # 看当前值
qq_config { action: "max_turns", value: 200 }      # 改上限
```

或者 QQ-bot 页面的「每小时轮次上限」输入框。也可以写进 `cordis.patch.yml` 的 `maxTurnsPerHour`。

> **想立刻解除沉默**：重启一次 DSH。插件重新加载会重建会话运行时，预算计数归零，
> 机器人马上就能继续说话（顺便也让新的上限生效）。

### 登录二维码显示在页面上

机器人客户端是**后台运行**的（看门狗启动的 launcher 控制台用 `-WindowStyle Hidden`，
不弹任何窗口），所以登录二维码显示在 QQ-bot 页面的「登录」区块里：

- 已登录时显示昵称和 QQ 号；未登录时显示二维码图片 + 生成时间 + 刷新按钮。
- 读的是 OneBot 实现自己写的二维码文件（NapCat 在 `D:\NapCat\cache\qrcode.png`，
  可用 `login.qrcodePath` 改）。
- NapCat 大约每 2 分钟轮换一次二维码；页面打开时读一次，过期了点「刷新」。

**为什么不去隐藏 QQ 自己的窗口**：主号的 QQ 和机器人的 QQ 都是 `QQ.exe`，
按进程名匹配必然误伤。看门狗里现在有两道独立判定（见下），只对判定为机器人
自己的进程动手，并且**目标列表为空时什么都不做**。

### 实现上踩过的五个坑（改之前先看）

1. **Host 侧必须同时注入 `webServer`。** `connection.rpc.handle()` 内部是
   `owner.effect(() => owner.webServer.register(route))` —— 它要用**读取 connection 服务的那个 ctx**
   去拿 `webServer`。只写 `ctx.inject(['connection'], cb)` 的话，注入 ctx 看不到 `webServer`，
   注册会抛错并被 Cordis 吞掉，页面只能拿到一个看不出原因的 **405**。
   正确写法：`ctx.inject(['connection', 'webServer'], cb)`。
2. **客户端优先用 `ctx.get(name)`，不要用 `ctx.<服务名>`。** 前者在服务缺失时返回 `undefined`，
   后者会**抛**。另外注册项上的 `inject: () => ({...})` 面在本 Harness 构建里并不总是送达组件；
   页面因此把 `ctx` 用闭包带进去，并在失败时把探测结果直接印在页面上。
3. **人格提示词是在 agent 创建时注入的，改完不会自动生效。** "改完下一条消息就生效"靠
   `retireChat()`：保存提示词时把那个群的 agent 淘汰一次，下一条消息用新人格重建
   （会话历史保留；正忙时等这一轮答完再重建）。**已实测验证**：同一条会话里把人设从英文
   改成「西瓜」开头，下一轮回复立刻变成 `西瓜你好…`。
4. **别拿"切换语言"当人格是否生效的判定标准 —— 我在这上面误判过。** 给一个全新群设了
   "answer ONLY in English"，回复仍然是中文，我据此断定"人格根本没注入"，还回滚了一个
   其实没问题的改动。真实原因是：中文会话 + DSH 自身的中文系统提示下，模型可能就是不切换语言。
   **要验证请用中文 canary**（比如"必须用「西瓜」开头"），那种结果无法被默认人设解释。
5. **客户端的 hook 依赖不能是每次渲染都新建的东西。** `rpc.call.bind(rpc)` 每次渲染都是新函数，
   会让 `useEffect` 每轮重跑 → 无限拉数据 → 输入框里的字被瞬间冲掉，页面看起来像只读的。
   凡是进 `useCallback`/`useEffect` 依赖的值都要 `useMemo` 稳定住。
   测试里的迷你 React 也必须**像真 React 一样比较依赖数组**，否则这类死循环测不出来。

Host 侧每个分支都打了 `qq-bridge:` 前缀的 info 日志，排查时先看跑 `dsh web` 的那个窗口。

---

## 让 NapCat 常驻

`D:\NapCat` 下带了一套看门狗，由计划任务 `DSH-QQBot-KeepAlive` 在登录时以**最高权限**拉起：

- **开机/登录自动启动**，启动 NapCat 不再弹 UAC；
- **崩溃自动拉起**：每 15 秒检查一次「引导进程在 + 3000 端口通」；
- **会区分「死了」和「在等扫码登录」**：后者绝不反复重启（否则会把登录窗口一次次关掉），最多等 15 分钟才重试一次；
- **只杀机器人自己的进程**：机器人的 QQ 进程整棵树挂在 `NapCatWinBootMain.exe` 之下，而你自己的 QQ 挂在 explorer 之下 —— 靠这个特征区分，绝不会误杀主号；
- 拉起失败带指数退避（90s → 180s → … 最多 15 分钟），不会疯狂重启。

| 文件 | 作用 |
| --- | --- |
| `D:\NapCat\keepalive.ps1` | 看门狗本体 |
| `D:\NapCat\logs\keepalive.log` | 看门狗日志（排查必看） |
| `D:\NapCat\install-keepalive.ps1` / `.bat` | 注册/重装计划任务（需要一次 UAC） |
| `D:\NapCat\启动QQ机器人.bat` | 恢复自愈（不需要管理员） |
| `D:\NapCat\停止QQ机器人.bat` | 暂停：看门狗会主动关掉机器人并挂起自愈（不需要管理员） |

---

## 三种会话模式

### 群聊模式

| 模式 | 行为 |
| --- | --- |
| `off` | 完全不理会这个群 |
| `mention` | **默认**。只有被 @ 时才触发；被 @ 之后如果模型只是写了文字没调用工具，插件会把最后一段回复发进群（毕竟人家问你了） |
| `auto` | 自动跟聊：群安静 `debounceMs`（默认 12 秒）后触发一轮；模型**只有调用 `qq_reply` 才会发言**，不调用就保持沉默 |

优先级：`运行时设置（qq_group_mode / 状态文件）` > `config.groups[群号]` > `config.defaultGroupMode`。

另外还有 `allowGroups`（非空时变成白名单）和 `denyGroups` 两道过滤。

### 私信遥控（这就是「远程指挥 DSH」）

1. 把**你自己的 QQ 号**加进 `ownerIds`（`qq_config action=owner`）。
2. 用这个号私信机器人，内容就是给 DSH 的指令。
3. 插件把它投进一个固定的 DSH 会话（默认 id `qq-remote`，标题「QQ 遥控」），跑完把**最后一段回复**发回你的 QQ。
4. 你也可以在 DSH 界面里直接打开这个会话看完整过程，甚至插话。

可以用的斜杠指令（不走模型，秒回）：

```
/help                 看指令列表
/status               桥接状态
/groups               已知的群和模式
/mode <群号> off|mention|auto
/reset                开一个新的 DSH 会话
/stop                 打断当前任务
/ping
```

其他任何文字都会作为指令交给 DSH。

### 陌生人私信

默认 `privateFromOthers: ignore`（只认主人）。改成 `chat` 之后，每个陌生人各自一个 DSH 会话，模型用 `qq_reply` 回话。

---

## 工具清单

| 工具 | 作用 |
| --- | --- |
| `qq_status` | 连接、登录号、上报地址、群模式、各会话忙闲、收发统计 |
| `qq_config` | 运行时改配置：`show` / `endpoint` / `owner` / `default_mode` / `dry_run` / `private_from_others` / `reset` |
| `qq_list_groups` | 列出加入的群 |
| `qq_list_friends` | 列出好友 |
| `qq_group_members` | 列出群成员（想 @ 谁先查 QQ 号） |
| `qq_send_group` | 主动往群里发消息（可带 `at_user`） |
| `qq_send_private` | 主动发私信 |
| `qq_recent_messages` | 读插件缓存的最近消息（不依赖 OneBot 历史接口） |
| `qq_group_mode` | 查/改某个群的模式 |
| `qq_chats` | 列出所有 QQ 会话及其状态 |
| `qq_client` | `probe` / `launch` / `stop` / `version`，管理本机 OneBot 客户端进程 |
| `qq_reply` | **只在某个 QQ 会话内部可见**：把消息发到当前这个群/这个人 |

---

## 配置项

全部配置在 `cordis.patch.yml` 的 `config:` 下（运行时可用 `qq_config` 覆盖其中一部分）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时只注册工具、不连接 |
| `dryRun` | `false` | `true` 时任何消息都只写日志，不真的发出去。第一次接通建议先开 |
| `apiBaseUrl` | `http://127.0.0.1:3000` | OneBot HTTP API 根地址 |
| `accessToken` | `''` | OneBot 访问令牌 |
| `requestTimeoutMs` | `15000` | 调用 OneBot 的超时 |
| `listenHost` | `127.0.0.1` | 事件服务监听地址 |
| `listenPort` | `8799` | 事件服务端口，`0` 表示随机 |
| `listenPath` | `/onebot` | 上报路径 |
| `reportSecret` | `''` | 上报签名密钥；填了就必须带签名 |
| `selfId` | `null` | 机器人 QQ；留空自动从 `get_login_info` 获取 |
| `ownerIds` | `[]` | 可以遥控 DSH 的 QQ 号 |
| `privateFromOthers` | `ignore` | `ignore` / `chat` |
| `defaultGroupMode` | `mention` | `off` / `mention` / `auto` |
| `groups` | `{}` | 每个群的模式覆盖，如 `{ "123456": "auto" }` |
| `allowGroups` / `denyGroups` | `[]` | 白名单 / 黑名单（群号字符串） |
| `debounceMs` | `12000` | auto 模式：静默多久算「说完一段」 |
| `mentionDebounceMs` | `1200` | mention 模式：合并连发消息的窗口 |
| `contextMessages` | `12` | 每轮带给模型的历史条数 |
| `maxTurnsPerHour` | `30` | 每个会话每小时最多触发几轮 |
| `maxBufferMessages` | `120` | 每个会话缓存多少条消息 |
| `maxCharsPerTurn` | `6000` | 单轮文本上限 |
| `busyTimeoutMs` | `600000` | 一轮超过这么久没结束就判定卡住，继续处理新消息 |
| `cwd` | `null` | QQ 会话的工作目录；留空用第一个 DSH 工作区 |
| `agentPreset` | `null` | 给 QQ 会话挂哪个 agent 预设；留空用部署默认 |
| `remote.*` | — | 遥控通道：`enabled` / `sessionId` / `title` / `ack`（先回「收到」）/ `toolAllow`（`null` = 不限制，全权限） |
| `groupSessions.toolAllow` | `['qq_*','web_search','web_fetch']` | **群会话能用哪些工具** |
| `privateChat.toolAllow` | 同上 | 陌生人私信会话的工具白名单 |
| `persona.group` / `.remote` / `.privateChat` / `.common` | 内置中文人设 | 每个会话说的话术规则，可直接覆写 |
| `client.enabled/command/args/cwd` | 关闭 | 让插件顺手启动本机 OneBot 客户端进程 |
| `logLevel` | `info` | `debug` 会打印更多排查信息 |
| `dataDir` | `<DSH_HOME 或 ~/.dsh>/qq-bridge` | 状态文件目录（群模式等） |

---

## 安全须知（请认真看）

- **群会话默认拿不到本机能力。** 群里的模型只能看到 `qq_*`、`web_search`、`web_fetch`，碰不到文件、终端、`pwsh`。想放开就在 `groupSessions.toolAllow` 里加，但请想清楚：**群里任何人说的话都会变成提示词**。
- **遥控会话默认全权限。** 因为它的用途就是让你在手机上指挥 DSH 干活。要收紧就设 `remote.toolAllow`。
- **`ownerIds` 是唯一的身份凭证。** 谁能发出这些私信，谁就等于坐在你电脑前。别把机器人 QQ 号给别人用，建议用小号。
- **第一次接通先开 `dryRun`。** 看着日志确认行为对了再关掉。
- **事件服务默认只监听 127.0.0.1。** 如果改成对外地址，一定同时设置 `reportSecret`，否则本机任何程序都能伪造 QQ 消息来喂你的模型。
- **API Key / Token / 聊天记录都在本机**，状态文件是明文 JSON，分享目录时记得删。
- 机器人会**真的以你的 QQ 身份发言**，被 @、被私信都可能触发一轮完整的 agent turn，**会消耗模型额度**。`maxTurnsPerHour` 和 `mention` 默认值就是为了防止失控。

---

## 常见问题

**`qq_status` 说未连接 / ECONNREFUSED**
OneBot 客户端没启动、没登录，或者 `apiBaseUrl` 的端口不对。用 `qq_client { action: "probe" }` 复测。

**群消息进来了但机器人不说话**
1. 看 `qq_status` 里的「群与模式」，确认这个群不是 `off`、也没被 allow/deny 过滤掉；
2. `mention` 模式下必须真的 @ 到机器人（@全体不算特殊处理，会当成 @ 机器人）；
3. `auto` 模式下模型有权保持沉默，这是设计行为；
4. 用 `qq_chats` 看会话是否「正在回复」，看 `最近错误`。

**被 @ 了但群里没反应**
看 `qq_chats` 里那个会话的「本小时轮次」是不是撞到 `maxTurnsPerHour` 了；再看 DSH 里那个会话本身有没有报错。

**端口被占用**
插件会自动换端口并在日志里说明；以 `qq_status` 里的「事件上报地址」为准去配置 OneBot 上报地址。

**改了源码怎么生效**
重启 DSH。切换 bundle 开关只会重新挂载，不会换掉已加载的 JS 模块。

---

## 开发与测试

```powershell
cd <本目录>
node --test "test/*.test.mjs"     # 48 个用例：纯函数 / 桥接逻辑 / HTTP 传输 / 插件入口
node test/mock-onebot.mjs --port 3000   # 起一个假的 OneBot，用来手工联调
```

- `test/mock-onebot.mjs` 是一个完整的假 OneBot 服务，实现了插件用到的所有 API，并把收到的调用记录下来。
  运行中访问 `http://127.0.0.1:3000/_calls` 可以看它收到了什么。
- `test/harness.mjs` 提供一个假的 Cordis 宿主上下文（工具注册表、会话注册表、系统提示词），
  所以绝大部分逻辑不用真的启动 DSH 就能测。
- 目录结构：`lib/onebot.js`（协议）· `lib/text.js`（消息段）· `lib/state.js`（状态）·
  `lib/config.js`（配置）· `lib/bridge.js`（编排）· `lib/tools.js`（工具）· `lib/index.js`（插件入口）。
  只依赖 Node 内置模块 —— profile 里安装的 bundle 在运行时解析不到 `@deepseek-ai/*`。

## 许可

MIT。

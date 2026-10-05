# dsh-qq-bridge — a DSH ⇄ QQ bridge

Connect a local QQ account to [DeepSeek Harness](https://github.com/deepseek-ai): **answer group chats (only when mentioned, or follow them on their own), and let a marked account drive DSH from a private message.**

It speaks **OneBot v11**, so NapCat, SnowLuma, Lagrange, LLOneBot and friends all work unchanged — the plugin is not tied to any one implementation.

中文文档（含完整搭建步骤与安全说明）：[README.zh.md](README.zh.md)

---

## What it does

| Capability | Behaviour |
| --- | --- |
| Group @-reply | A mention hands the recent conversation plus the trigger to one DSH session; the model decides what to say |
| Group auto-follow | After the group goes quiet for `debounceMs`, a turn starts; the model speaks only by calling `qq_reply` |
| Private remote control | A private message from an owner QQ becomes a DSH instruction, and the answer is relayed back |
| Session routing | Send those instructions into a **session you pick** (any existing one, or a fresh one) instead of a bridge-owned session |
| Per-group persona | A different system prompt for each group, editable live from the settings page or with `qq_group_prompt` |
| Stickers | A folder of images the model can send, plus QQ's built-in face emoji |
| Stranger private chat | Optional: one DSH session per stranger, replying through `qq_reply` |
| Settings page | A **QQ-bot** page inside DSH settings: live status, every knob, the group list, the login QR |
| Safety | Dry run, group allow/deny, hourly turn budget per chat, report signature, per-kind tool allow-list |

Every group, every stranger, and your command channel gets its **own DSH session**, visible in the workspace list so you can watch or join the conversation.

## Requirements

- DeepSeek Harness with the Web UI
- A **spare** QQ account for the bot (never your main one)
- A local OneBot v11 implementation reachable on `127.0.0.1:3000` (NapCat is what this was built against)
- Node 20+ (the plugin uses Node builtins only — a profile-installed bundle cannot resolve `@deepseek-ai/*` at runtime)

## Install

Install this package as a DSH bundle (the plugin manager's install-bundle action takes a path or a package spec). The bundle patch in `cordis.patch.yml` adds one loader row, `qq-bridge`.

> **A restart is required the first time.** `package.json`'s `dsh.client` field is read and cached at startup, so the settings page only appears after DSH restarts once. Client-half edits afterwards hot-reload; host-half edits (`lib/bridge.js`, `lib/tools.js`, `lib/rpc.js`) always need a restart.

## Quick start

1. **Run an OneBot implementation** — start NapCat, scan its QR with the spare account.
2. **Point the bridge at it**, from any DSH chat:

   ```
   qq_config { action: "endpoint", api_base_url: "http://127.0.0.1:3000" }
   qq_config { action: "owner", owner_id: "<your own QQ number>" }
   ```

3. **Configure the client's report target** to the address `qq_status` prints (`http://127.0.0.1:8799/onebot` by default).
4. **Verify** with `qq_status`, or open **Settings → QQ-bot**.

Turn on `dryRun` for the first connection: every outgoing message is then logged instead of sent.

## The QQ-bot settings page

| Block | What you can do |
| --- | --- |
| Login | Live login state; **the login QR is displayed here** while the client is logged out, so a headless client never needs a visible window |
| Config | dryRun, OneBot URL/token, default group mode, stranger policy, hourly turn budget, owner list |
| Remote | Pick which DSH session your private messages go to, or start a fresh one |
| Groups | One card per group: answering mode **and that group's own persona** |

## Tools

14 global tools — `qq_status` `qq_config` `qq_list_groups` `qq_list_friends` `qq_group_members` `qq_send_group` `qq_send_private` `qq_recent_messages` `qq_group_mode` `qq_group_prompt` `qq_sticker` `qq_remote` `qq_chats` `qq_client` — plus a per-conversation `qq_reply` that only exists inside one QQ session.

Owner slash commands, answered without spending a model turn: `/help` `/status` `/groups` `/mode` `/use` `/reset` `/stop` `/ping`.

### Group personas

Each group can have its own system prompt, which replaces the shared group persona **for that group only**. The reply mechanics (must call `qq_reply`, no Markdown, current group and time) stay appended, so an override can't break how it replies.

```
qq_group_prompt { group_id: "123456", prompt: "This is a work group; be brief and formal." }
```

A prompt edit rebuilds that group's agent once, so it takes effect on the very next message — and if the group is mid-answer, the rebuild waits for the turn to end rather than cutting it off.

### Stickers

Drop images in the sticker folder (`<data dir>/stickers`, configurable) and the file name becomes the sticker name:

```
qq_sticker { action: "list" }
qq_sticker { action: "send", target_kind: "group", target_id: "123456", sticker: "happy" }
```

`sticker` accepts a folder name, `face:178` for a QQ built-in emoji, an image URL, or an absolute path. Local files travel as `base64://`, which sidesteps every path-permission difference between OneBot implementations.

### Remote control routing

By default the owner's private messages go to a bridge-owned session. Point them somewhere real instead — any existing session, or a new one:

```
/use list          # recent sessions
/use <session id>  # route there (resumed if it isn't running)
/use new           # a fresh session
/use off           # back to the bridge-owned one
```

Only turns the plugin itself starts are relayed back to QQ, so chatting with that session in the UI does not spam your phone.

## Safety, briefly

- Group sessions can only reach `qq_*`, `web_search` and `web_fetch` by default — **anything typed in a group is prompt input**.
- The owner session inherits every tool, because remote control is the point; tighten it with `remote.toolAllow`.
- `ownerIds` is the only credential: whoever can send those private messages sits at your machine. Use a spare QQ account.
- The event server binds loopback; if you expose it, set `reportSecret`.
- Every trigger is a full agent turn and costs model quota. `maxTurnsPerHour` (default 120, per chat, rolling hour) is the guard rail — when a chat exhausts it, the bot goes quiet until the hour rolls. Raise it with `qq_config { action: "max_turns", value: 200 }` or on the settings page.

## Keeping the client alive (Windows)

`tools/napcat-windows/` has a watchdog that keeps NapCat running with no visible window: started at logon by a scheduled task with highest privileges, revived on crash with exponential backoff, and never confused by a closed console. See [its README](tools/napcat-windows/README.md).

## Development

```powershell
node --test "test/*.test.mjs"           # 94 cases
node test/mock-onebot.mjs --port 3010   # a fake OneBot service for manual testing
```

The suite covers pure functions, bridge orchestration, the HTTP transport, the RPC layer, the plugin entry, and the client page itself — `test/client-render.test.mjs` runs the page through a miniature React renderer whose hooks honour dependency arrays exactly like the real thing, which is what catches render-loop regressions.

`test/harness.mjs` provides a fake Cordis host context (tool registry, agent registry, system prompt), so most behaviour is testable without booting DSH.

`lib/onebot.js` (protocol) · `lib/text.js` (message segments) · `lib/stickers.js` (sticker resolution) · `lib/state.js` (persistence) · `lib/config.js` (config) · `lib/bridge.js` (orchestration) · `lib/tools.js` (tools) · `lib/rpc.js` (settings-page RPC) · `lib/client.js` (settings page) · `lib/index.js` (entry).

## License

MIT

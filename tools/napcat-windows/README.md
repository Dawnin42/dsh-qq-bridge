# NapCat keep-alive (Windows)

Keeps a NapCat-based QQ bot running without a visible console window: start it
once at logon, revive it when it dies, and never let a closed window kill it.

These scripts live **inside your NapCat installation directory** (the folder that
has `launcher.bat` / `NapCatWinBootMain.exe`). Every path is derived from the
script's own location, so nothing here is hard-coded.

## Install

Double-click **`install-keepalive.bat`** (one UAC prompt). It registers the
scheduled task `DSH-QQBot-KeepAlive`, which:

- starts `keepalive.ps1` at logon, **with highest privileges and a hidden window**
- therefore starts NapCat without another UAC prompt
- therefore is the only thing able to kill the elevated NapCat / QQ processes

## Day to day

| File | What it does |
|---|---|
| `start-bot.bat` | Resume. No admin needed. |
| `stop-bot.bat` | Pause: the watchdog kills the bot and stops reviving it. No admin needed. |
| `logs\keepalive.log` | Watchdog log — read this first when something is wrong. |
| `logs\install-keepalive.log` | Install log. |

## The state machine

| State | Meaning | Action |
|---|---|---|
| `healthy` | boot process alive + port 3000 answering | nothing |
| `login-pending` | boot process alive + port 6099 up + 3000 down | **never restart** — QQ is waiting for a QR scan, and restarting would close it over and over |
| `starting` | start command just issued | wait (up to 120 s) |
| `dead` | no boot process | start it, with exponential backoff up to 15 min |

## Why the scripts look like this

- **`.bat` files are ASCII-only.** A UTF-8 BOM plus `chcp 65001` makes `cmd.exe`
  mis-parse the rest of the file. Cost an afternoon once; not again.
- **`.ps1` files are saved as UTF-8 *with* BOM.** Windows PowerShell 5.1 reads a
  BOM-less UTF-8 script as GBK, which turns every Chinese comment into a syntax
  error and silently breaks the watchdog.
- **The watchdog never hides windows it does not own.** Your own QQ and the bot's
  QQ are both `QQ.exe`; matching by process name hides the wrong one. Anything
  that needs to touch bot processes must identify them by parentage
  (`NapCatWinBootMain` ancestry + the processes holding ports 3000/6099), and do
  nothing at all when that list is empty.

## Requirements

- Windows 10/11, PowerShell 5.1 (PowerShell 7 is used when present)
- An OneBot v11 client reachable on `127.0.0.1:3000`

The login QR is written by NapCat to `<root>\cache\qrcode.png` while it is logged
out — the [dsh-qq-bridge](https://github.com/) plugin can display it in the DSH
web UI, so a background client never needs a visible window.

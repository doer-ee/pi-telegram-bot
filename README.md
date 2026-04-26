# pi-telegram-bot

A private Telegram control surface for people who already use Pi locally and want to run coding sessions remotely from their phone.

It solves a simple problem: when you're away from your keyboard, you can still start sessions, send prompts, switch sessions, and check status without exposing your machine through a public web app.

Telegram works well here because it's fast on mobile, has reliable push notifications, and gives you a familiar command/chat UX from anywhere.

**Pi** is a local coding-agent runtime/SDK that runs sessions on your machine and executes work in your configured workspace.

## Security model (by design)

- exactly one authorized Telegram user ID can use the bot
- Pi runs on your local machine only
- there is no hosted web dashboard in this project

## What this project is not

- not a multi-user bot
- not a group-chat bot
- not a remote-hosted SaaS control plane
- not a replacement for Pi setup/auth (Pi must already work locally)

> Status: MVP for a single-user, single-workspace workflow.

## What it does

- runs Pi locally with no separate web service
- restricts access to one Telegram user ID
- keeps one selected session active and persists that selection across restarts
- lets you change the current session's active conversation model with `/model`
- supports `/new`, `/sessions`, `/switch`, `/current`, `/status`, and `/abort`
- registers the Telegram command menu on startup
- streams replies back into Telegram and falls back to plain text if Markdown formatting is rejected
- keeps a pinned `Active session:` message in sync when the active session has a title
- creates a quick heuristic title for new sessions, then optionally refines it in the background

## Quick start (60 seconds)

```bash
bun install
cp .env.example .env
```

Set required vars in `.env`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_AUTHORIZED_USER_ID`
- `PI_WORKSPACE_PATH`

Run the bot:

```bash
bun run dev
```

In Telegram, message your bot:

```text
/new
```

## Requirements

- Node.js 20.10+
- Bun for dependency install and project scripts
- a Telegram bot token from BotFather
- your numeric Telegram user ID
- a local Pi setup that already works on this machine

This project does not log you into Pi or configure provider credentials for you. Pi must already be usable through the Pi SDK before this bot starts.

## Installation and setup

Run all commands from the repository root.

### 1. Install dependencies

```bash
bun install
cp .env.example .env
```

### 2. Create the Telegram bot with BotFather

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Pick a display name for the bot.
4. Pick a username that ends with `bot`.
5. Copy the token BotFather returns.
6. Put that token into `.env` as `TELEGRAM_BOT_TOKEN`.

No manual Telegram command-menu setup is required. The app calls `setMyCommands` on startup.

### 3. Get your Telegram user ID

You need your own numeric user ID for `TELEGRAM_AUTHORIZED_USER_ID`.

Common ways to get it:

- message [@userinfobot](https://t.me/userinfobot) and copy the numeric ID it returns
- or send a message to your bot, then inspect `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` and use the private-chat `from.id` value

Use your personal numeric ID, not your `@username` and not the bot's ID.

### 4. Configure `.env`

At minimum, set:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_AUTHORIZED_USER_ID`
- `PI_WORKSPACE_PATH`

Example:

```dotenv
TELEGRAM_BOT_TOKEN=replace-with-your-botfather-token
TELEGRAM_AUTHORIZED_USER_ID=123456789
PI_WORKSPACE_PATH=/absolute/path/to/your/pi-workspace
BOT_STATE_PATH=./data/state.json
```

### 5. Start the bot

Development:

```bash
bun run dev
```

Built run:

```bash
bun run build
bun run start
```

## Configuration reference

### Env-file loading behavior

The app force-loads an env file at startup.

1. If `PI_TELEGRAM_BOT_ENV_PATH` is set in the parent environment, that file is loaded.
2. Otherwise the project `.env` file is loaded.
3. Values from the loaded file overwrite inherited shell or service environment variables with the same names.
4. If the selected env file is missing or unreadable, startup fails immediately.

Important: do not set `PI_TELEGRAM_BOT_ENV_PATH` inside `.env`. That value has to exist before the app decides which env file to read.

### Environment variables

| Variable | Required | Purpose | Notes |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from BotFather. | Startup fails if missing. |
| `TELEGRAM_AUTHORIZED_USER_ID` | Yes | Numeric Telegram user ID allowed to use the bot. | Must be a positive integer. |
| `PI_WORKSPACE_PATH` | Yes | Workspace controlled by the bot. | Must point to an existing directory. |
| `BOT_STATE_PATH` | No | Local JSON file for selected-session, pin, and model-recency metadata. | Defaults to `./data/state.json`. |
| `PI_AGENT_DIR` | No | Optional Pi agent directory override. | Leave blank to use the Pi SDK default for this machine. |
| `PI_SESSION_TITLE_REFINEMENT_MODEL` | No | Background-only model for session-title refinement. | Defaults to `openai/gpt-5.4-mini`; provider-qualified values are recommended. |
| `TELEGRAM_STREAM_THROTTLE_MS` | No | Minimum delay between streamed reply updates. | Default `1000`, minimum `250`. |
| `TELEGRAM_CHUNK_SIZE` | No | Max characters per Telegram message chunk. | Default `3500`, valid range `512` to `4000`. |

Relative paths resolve from the current working directory. If you run the app from the repo root, the default `BOT_STATE_PATH=./data/state.json` stays inside this project.

## Daily Telegram usage

Use the bot from the authorized private Telegram account.

Available commands:

- `/start`
- `/help`
- `/status`
- `/new`
- `/sessions`
- `/switch <session-id-prefix-or-id>`
- `/current`
- `/model`
- `/abort`

Behavior notes:

- any non-command text message is sent to the selected session
- if no session is selected yet, the first freeform text message creates one automatically
- `/sessions` shows recent sessions and inline buttons for switching
- `/switch` also supports a unique session ID prefix
- `/model` opens an inline picker for actually available models for the current session's active conversation model
- `/model` shows recently used models first for the current workspace
- `/model` does not change the separate background title-refinement model
- while a run is active, new prompts, `/new`, session switches, and model changes are rejected until the run finishes or you use `/abort`
- non-text Telegram attachments are not sent to Pi in this MVP

## Demo

Add a short GIF or MP4 showing this exact flow:

1. `/new`
2. send a prompt
3. `/status`
4. `/switch`
5. `/abort`

Suggested asset paths:

- `docs/demo.gif` (autoplays in GitHub README)
- `docs/demo.mp4` (optional higher quality)

Embed example:

```md
![Demo: /new → prompt → /status → /switch → /abort](docs/demo.gif)
```

## Local-only files and repo hygiene

The public repo is meant to keep secrets and runtime output out of version control.

- `.env` is local-only and should never be committed
- `node_modules/` and `dist/` are generated output
- `data/` stores local selected-session and pin state
- `tmp/` stores local temporary diagnostics

The included `.gitignore` excludes those paths for public upload.

## macOS service setup

This repo includes user-level `launchd` scripts for macOS.

Install and verify the LaunchAgent:

```bash
bun run build
bun run service:install
bun run service:status
```

The installed LaunchAgent:

- is written to `~/Library/LaunchAgents/com.doer.pi-telegram-bot.plist`
- runs `node dist/index.js`
- sets `PI_TELEGRAM_BOT_ENV_PATH` to the project `.env`
- writes logs under `~/Library/Logs/pi-telegram-bot/`
- starts at login with `RunAtLoad`

Daily service commands:

```bash
bun run service:start
bun run service:stop
bun run service:restart
bun run service:uninstall
```

Service caveats:

- rebuild before `service:restart` after code changes
- rerun `service:install` after LaunchAgent config changes such as a moved Node binary or updated log path
- run the service commands from a logged-in macOS desktop session
- the bundled service flow is not for Linux, Windows, or root-daemon use

Useful log checks:

```bash
tail -f ~/Library/Logs/pi-telegram-bot/stdout.log
tail -f ~/Library/Logs/pi-telegram-bot/stderr.log
```

## Architecture at a glance

- `src/index.ts` loads env, validates config, and wires the app together
- `src/config/*` resolves and validates env-driven configuration
- `src/pi/*` creates Pi SDK runtimes and handles background title refinement
- `src/session/*` owns session selection, busy-state enforcement, and prompt routing
- `src/telegram/*` handles commands, reply streaming, formatting, and session-pin sync
- `src/state/*` persists local bot-owned state
- `scripts/*` and `launchd/*` manage the optional macOS LaunchAgent

## Troubleshooting

### `Unauthorized user.`

`TELEGRAM_AUTHORIZED_USER_ID` is wrong, not numeric, or belongs to a different Telegram account.

### `Failed to load project env file`

The selected env file is missing or unreadable. Check `.env` or the parent-shell value of `PI_TELEGRAM_BOT_ENV_PATH`.

### Workspace or agent-dir path errors

`PI_WORKSPACE_PATH` and `PI_AGENT_DIR`, when set, must point to existing directories.

### The bot is busy

Only one Pi run can be active at a time. Wait for completion or use `/abort`.

### The service does not start

Check these in order:

1. `bun run build` completed successfully.
2. `.env` exists and is correct.
3. `bun run service:status` shows the installed LaunchAgent.
4. `~/Library/Logs/pi-telegram-bot/stderr.log` contains the real startup error.

## Verification

```bash
bun run build
bun run typecheck
bun run test
```

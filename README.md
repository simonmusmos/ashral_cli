# Ashral

A control center for AI coding agent sessions. Run Claude Code or OpenAI Codex on your dev machine and monitor, interact, and receive push notifications from your phone.

```
ashral run claude
ashral run codex
ashral resume <session-id>
```

---

## How it works

Ashral wraps your AI coding agent in a PTY, streams its output to a cloud backend, and forwards push notifications to your phone. A companion mobile app lets you watch the session live, reply to agent prompts, and pick up where you left off — all without being at your keyboard.

```
Dev Machine                  Backend (Vercel)              Mobile App
─────────────────────────    ──────────────────────────    ──────────────────
 ashral run claude            ashral_web (Express)          ashral_flutter
  ├─ PTY spawn          ──►   ├─ Firestore session store ◄─  ├─ Scan QR to join
  ├─ Anthropic proxy          ├─ FCM push routing            ├─ Live output feed
  ├─ Token/cost tracking      └─ REST API                    ├─ Reply to agent
  └─ QR code in terminal                                     └─ Push notifications
```

1. `ashral run claude` spawns Claude Code, creates a session, prints a QR code.
2. Scan the QR on your phone → join the session instantly.
3. Agent output streams to your phone in real time.
4. When the agent needs input or approval, your phone gets a push notification.
5. Reply from your phone — the response is delivered to the CLI.
6. When you're done, `ashral resume <id>` picks the session back up.

---

## Features

- **Live output streaming** — terminal output appears on your phone as it happens
- **Two-way interaction** — send messages to the agent directly from mobile
- **Push notifications** — get notified when the agent is waiting, needs approval, or errors out
- **Session resume** — resume a previous Claude Code session by its short ID
- **Cost tracking** — per-session token usage and spend calculated from Claude API traffic
- **QR join flow** — 8-character session codes, scannable QR, or gallery import
- **Multiple agents** — Claude Code and OpenAI Codex supported out of the box
- **Named sessions** — label sessions for easy identification across devices

---

## Repos

| Repo | Role | Stack |
|------|------|-------|
| **Ashral** (this) | CLI tool — spawns agents, proxies API traffic, streams output | Node.js / TypeScript, node-pty |
| **[ashral_web](../ashral_web)** | Backend API — session store, output relay, push notifications | Express, Firestore, FCM, Vercel |
| **[ashral_flutter](../ashral_flutter)** | Mobile companion app (iOS / Android) | Flutter, Firebase Auth, FCM |

---

## Installation

```bash
npm install -g ashral
```

On first install, Ashral checks that your agent CLI is available (`claude` or `codex`). Make sure at least one is installed and authenticated.

### Prerequisites

- **Claude Code**: `npm install -g @anthropic-ai/claude-code` (already logged in)
- **OpenAI Codex**: `npm install -g @openai/codex` (already logged in)
- Node.js ≥ 18

### Configuration

Ashral reads credentials from `~/.ashral/.env` (project-level `.env` also supported):

```env
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
BACKEND_URL=https://your-backend.vercel.app
```

---

## Usage

### Start a session

```bash
# Claude Code
ashral run claude

# OpenAI Codex
ashral run codex

# With a custom name
ashral run claude --name "refactor auth"
```

A QR code appears in your terminal. Scan it with the Ashral mobile app to join.

### Resume a session

```bash
ashral resume a1b2c3d4
# or full UUID
ashral resume a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Resumes the Claude Code conversation from where it left off (requires `agentSessionId` to have been saved when the session ran).

---

## Architecture notes

### PTY wrapping

Agents are spawned via `node-pty` rather than `child_process.spawn` so the agent sees a real terminal (preserves interactive TUI behaviour, colour output, etc.).

### Anthropic proxy

A local HTTPS proxy intercepts Claude's API traffic on `127.0.0.1`. This lets Ashral:
- Extract clean response text (stripped of `<system-reminder>` tags and ANSI)
- Track token counts and per-model cost without parsing noisy PTY output
- Detect when Claude transitions between states (running → waiting → approval)

### Codex support

OpenAI Codex reads its API endpoint from `~/.codex/config.toml`. Ashral patches this file on startup (and restores it on exit) to point at the local proxy, then rejects WebSocket upgrade requests so Codex falls back to HTTP SSE.

### Session state machine

```
starting → running → waiting_for_input ↔ running
                   → approval_required ↔ running
                   → completed
                   → error
                   → terminated
```

State transitions are detected by regex-matching PTY output and confirmed by proxy traffic patterns.

---

## Project status

Active development. Core flow (run → scan → watch → reply → resume) is working. Auth on the backend API is not yet enforced — self-host and restrict access accordingly.

---

## License

MIT

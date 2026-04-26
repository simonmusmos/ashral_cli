# Ashral

A control center for AI coding agent sessions. Run Claude Code or OpenAI Codex on your dev machine and monitor, interact, and receive push notifications from your phone.

```
ashral run claude
ashral run codex
ashral resume <session-id>
```

---

## How it works

Ashral wraps your AI coding agent, streams its output to a cloud backend, and forwards push notifications to your phone. A companion mobile app lets you watch the session live, reply to agent prompts, and pick up where you left off — all without being at your keyboard.

1. `ashral run claude` starts a session and prints a QR code in your terminal.
2. Scan the QR with the mobile app → join instantly.
3. Agent output streams to your phone in real time.
4. When the agent needs input or approval, your phone gets a push notification.
5. Reply from your phone — the response is delivered to the CLI.
6. `ashral resume <id>` picks the session back up later.

---

## Features

- **Live output streaming** — terminal output appears on your phone as it happens
- **Two-way interaction** — send messages to the agent directly from mobile
- **Push notifications** — get notified when the agent is waiting, needs approval, or errors out
- **Session resume** — resume a previous Claude Code session by its short ID
- **Cost tracking** — per-session token usage and estimated spend
- **QR join flow** — 8-character session codes, scannable QR, or gallery import
- **Multiple agents** — Claude Code and OpenAI Codex supported
- **Named sessions** — label sessions for easy identification across devices

---

## Repos

| Repo | Role | Stack |
|------|------|-------|
| **Ashral** (this) | CLI tool | Node.js / TypeScript |
| **ashral_web** | Backend API — session store, output relay, push notifications | Express, Firestore, Vercel |
| **ashral_flutter** | Mobile companion app (iOS / Android) | Flutter |

---

## Installation

```bash
npm install -g ashral
```

### Prerequisites

- **Claude Code** installed and authenticated, or
- **OpenAI Codex** installed and authenticated
- Node.js ≥ 18

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
```

Resumes the Claude Code conversation from where it left off.

---

## Project status

Active development. Core flow (run → scan → watch → reply → resume) is working.

---

## License

MIT

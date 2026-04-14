import * as pty from 'node-pty';
import type { BaseAdapter } from '../adapters/baseAdapter';
import { SessionState } from './sessionState';
import type { AshralEvent } from '../types/events';
import { startAnthropicProxy } from '../proxy/anthropicProxy';

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B[@-_][0-?]*[ -/]*[@-~]/g;

/**
 * Rolling buffer of the last N clean lines of PTY output.
 * Used only for status detection and push notification body extraction.
 */
function makeOutputBuffer() {
  const lines: string[] = [];
  const MAX = 40;

  function push(raw: string): void {
    const cleaned = raw
      .replace(ANSI_RE, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 1);
    lines.push(...cleaned);
    if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  }

  function extractBody(): string | undefined {
    const candidates = lines
      .filter((l) => !l.includes('[ashral]'))
      .filter((l) => !/^\d+\.\s/.test(l))
      .filter((l) => !/^[╭╰╮╯│─❯>\s□↓↑←→]+$/.test(l))
      .filter((l) => !/→\s*\w+_\w+/.test(l));

    const question = [...candidates].reverse().find((l) => l.endsWith('?'));
    const body = question ?? candidates[candidates.length - 1];
    return body ? body.slice(0, 200) : undefined;
  }

  return { push, extractBody };
}

export interface RunSessionOptions {
  adapter: BaseAdapter;
  name?: string;
  /** Pre-generated session ID — pass this to show a QR before spawning */
  sessionId?: string;
  /** Extra args forwarded verbatim to the agent CLI (everything after --) */
  passthroughArgs: string[];
  onEvent: (event: AshralEvent) => void;
}

/**
 * Spawns the agent inside a PTY, bridges all I/O, and drives the session
 * state machine. Resolves when the agent process exits.
 */
export async function runSession(options: RunSessionOptions): Promise<void> {
  const { adapter, name, sessionId, passthroughArgs, onEvent } = options;
  const cwd = process.cwd();
  const { columns = 80, rows = 24 } = process.stdout;

  const state = new SessionState(adapter.agentName, name, cwd, onEvent, sessionId);
  const config = adapter.getCommand(passthroughArgs);

  // Start the transparent Anthropic proxy — Claude Code's API traffic flows
  // through it so we can capture clean assistant text without touching the PTY.
  const proxy = await startAnthropicProxy(state.id).catch(() => null);

  const baseEnv = { ...(process.env as Record<string, string>), ...(config.env ?? {}) };
  const env: Record<string, string> = proxy
    ? { ...baseEnv, ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}` }
    : baseEnv;

  const term = pty.spawn(config.command, config.args, {
    name: 'xterm-color',
    cols: columns,
    rows,
    cwd,
    env,
  });

  state.transition('running');

  const buffer = makeOutputBuffer();

  // ── Output: mirror PTY → stdout, inspect for state changes ─────────────────
  term.onData((data: string) => {
    process.stdout.write(data);

    onEvent({
      type: 'output',
      sessionId: state.id,
      timestamp: new Date(),
      data,
    });

    buffer.push(data);

    const next = adapter.detectStatus(data, state.status);
    if (next !== null) {
      state.transition(next, buffer.extractBody());
    }
  });

  // ── Input: forward stdin → PTY ──────────────────────────────────────────────
  const isTTY = process.stdin.isTTY ?? false;
  if (isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  const onStdinData = (chunk: Buffer) => {
    term.write(chunk.toString('binary'));
    if (state.status === 'waiting_for_input' || state.status === 'approval_required') {
      state.transition('running');
    }
  };
  process.stdin.on('data', onStdinData);

  // ── Resize: keep PTY columns/rows in sync with the terminal ─────────────────
  const onResize = () => {
    const { columns: cols = 80, rows: r = 24 } = process.stdout;
    term.resize(cols, r);
  };
  process.stdout.on('resize', onResize);

  function teardown() {
    process.stdin.removeListener('data', onStdinData);
    process.stdout.removeListener('resize', onResize);
    if (isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  return new Promise((resolve) => {
    term.onExit(async ({ exitCode, signal }) => {
      teardown();
      await proxy?.stop();

      if (signal && exitCode !== 0) {
        onEvent({
          type: 'error',
          sessionId: state.id,
          timestamp: new Date(),
          message: `Agent killed by signal ${signal}`,
        });
        state.transition('error');
      }

      state.complete(exitCode);
      resolve();
    });
  });
}

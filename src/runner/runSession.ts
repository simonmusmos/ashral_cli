import * as pty from 'node-pty';
import type { BaseAdapter } from '../adapters/baseAdapter';
import { SessionState } from './sessionState';
import type { AshralEvent } from '../types/events';

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B[@-_][0-?]*[ -/]*[@-~]/g;
const BUFFER_SIZE = 40;

/**
 * Rolling buffer of the last N clean lines of PTY output.
 * The question text often arrives in an earlier chunk than the one that
 * triggers the status change, so we look back across recent output.
 */
function makeOutputBuffer() {
  const lines: string[] = [];

  function push(raw: string): void {
    const cleaned = raw
      .replace(ANSI_RE, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 1);
    lines.push(...cleaned);
    if (lines.length > BUFFER_SIZE) lines.splice(0, lines.length - BUFFER_SIZE);
  }

  function extractBody(): string | undefined {
    const candidates = lines
      .filter((l) => !l.includes('[ashral]'))
      .filter((l) => !/^\d+\.\s/.test(l))
      .filter((l) => !/^[╭╰╮╯│─❯>\s□↓↑←→]+$/.test(l))
      .filter((l) => !/→\s*\w+_\w+/.test(l));

    // Prefer the last line ending with "?" — most likely the actual question
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

  // Merge adapter env overrides on top of the current environment
  const env = { ...(process.env as Record<string, string>), ...(config.env ?? {}) };

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
    // Write raw (ANSI-preserved) data so the terminal renders correctly
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
  // Raw mode disables line buffering and lets control characters (Ctrl+C etc.)
  // pass through as data to the PTY rather than being handled by Node.
  const isTTY = process.stdin.isTTY ?? false;
  if (isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  const onStdinData = (chunk: Buffer) => {
    term.write(chunk.toString('binary'));
    // User responded — reset to running so the next question fires a notification
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

  // ── Cleanup helper ───────────────────────────────────────────────────────────
  function teardown() {
    process.stdin.removeListener('data', onStdinData);
    process.stdout.removeListener('resize', onResize);
    if (isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  return new Promise((resolve, reject) => {
    term.onExit(({ exitCode, signal }) => {
      teardown();

      if (signal && exitCode !== 0) {
        // Process was killed by a signal — surface as an error event
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

    // Catch spawn errors (e.g. command not found)
    process.nextTick(() => {
      // node-pty doesn't emit an 'error' event; spawn failures surface as
      // immediate exits with code 127 or throw synchronously — handled above.
    });
  });
}

import * as pty from 'node-pty';
import type { BaseAdapter } from '../adapters/baseAdapter';
import { SessionState } from './sessionState';
import type { AshralEvent } from '../types/events';

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

    const next = adapter.detectStatus(data, state.status);
    if (next !== null) {
      state.transition(next);
    }
  });

  // ── Input: forward stdin → PTY ──────────────────────────────────────────────
  // Raw mode disables line buffering and lets control characters (Ctrl+C etc.)
  // pass through as data to the PTY rather than being handled by Node.
  const isTTY = process.stdin.isTTY ?? false;
  if (isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  const onStdinData = (chunk: Buffer) => term.write(chunk.toString('binary'));
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

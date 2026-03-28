#!/usr/bin/env node
import { Command } from 'commander';
import { runSession } from './runner/runSession';
import { ClaudeAdapter } from './adapters/claudeAdapter';
import { CodexAdapter } from './adapters/codexAdapter';
import { BackendNotifier } from './notifications/backendNotifier';
import { loadEnvFile } from './config/loadEnv';
import { showSessionQr } from './qr/showSessionQr';
import { createSession, deleteSession, notifySession } from './api/backendClient';
import { randomUUID } from 'crypto'; // fallback when backend is unreachable
import type { AshralEvent } from './types/events';

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';

function timestamp(): string {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

// ── Event handler ─────────────────────────────────────────────────────────────

function makeEventHandler(
  sessionId: string,
  sessionName: string | undefined,
): (event: AshralEvent) => void {
  const tag   = `${DIM}[ashral]${RESET}`;
  const label = sessionName ? `"${sessionName}"` : 'session';
  const notifier = new BackendNotifier(sessionId);

  return function onEvent(event: AshralEvent): void {
    if (event.type === 'output') return;

    const ts = `${DIM}${timestamp()}${RESET}`;

    switch (event.type) {
      case 'status_changed': {
        process.stderr.write(
          `\n${tag} ${ts} ${CYAN}status${RESET}  ${event.from} → ${event.to}\n`,
        );

        if (event.to === 'waiting_for_input') {
          notifier.send({
            title: `Ashral - ${label}`,
            body: 'Claude is waiting for your input.',
            priority: 'high',
          });
        } else if (event.to === 'approval_required') {
          notifier.send({
            title: `Ashral - ${label} [approval]`,
            body: 'Claude needs your approval before continuing.',
            priority: 'urgent',
          });
        } else if (event.to === 'error') {
          notifier.send({
            title: `Ashral - ${label} [error]`,
            body: 'Claude encountered an error.',
            priority: 'high',
          });
        }
        break;
      }

      case 'agent_prompt':
        process.stderr.write(`${tag} ${ts} ${YELLOW}prompt${RESET}   ${event.prompt}\n`);
        break;

      case 'error':
        process.stderr.write(`${tag} ${ts} ${RED}error${RESET}    ${event.message}\n`);
        break;

      case 'completed':
        process.stderr.write(
          `\n${tag} ${ts} ${GREEN}done${RESET}     exit code ${event.exitCode}\n`,
        );
        break;
    }
  };
}

// ── Shared run logic ──────────────────────────────────────────────────────────

async function runAgent(
  adapter: InstanceType<typeof ClaudeAdapter> | InstanceType<typeof CodexAdapter>,
  options: { name?: string },
  passthroughArgs: string[],
): Promise<void> {
  let sessionId: string = randomUUID(); // fallback if backend is unreachable

  try {
    sessionId = await createSession({ agent: adapter.agentName, name: options.name ?? adapter.agentName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ashral] Warning: could not register session with backend: ${msg}\n`);
  }

  showSessionQr(sessionId, options.name);

  try {
    await runSession({
      adapter,
      name: options.name,
      sessionId,
      passthroughArgs,
      onEvent: makeEventHandler(sessionId, options.name),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ashral] Fatal: ${message}\n`);
    process.exit(1);
  } finally {
    await deleteSession(sessionId);
  }
}

// ── CLI definition ────────────────────────────────────────────────────────────

loadEnvFile();

const program = new Command();

program
  .name('ashral')
  .description('Control center for AI coding agents')
  .version('0.1.0');

const runCmd = program.command('run').description('Run an AI coding agent');

runCmd
  .command('claude')
  .description('Start a Claude Code session')
  .option('--name <name>', 'human-readable session name')
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (options: { name?: string }, command: Command) => {
    await runAgent(new ClaudeAdapter(), options, command.args);
  });

runCmd
  .command('codex')
  .description('Start an OpenAI Codex session')
  .option('--name <name>', 'human-readable session name')
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (options: { name?: string }, command: Command) => {
    await runAgent(new CodexAdapter(), options, command.args);
  });

// ── notify:test ───────────────────────────────────────────────────────────────

program
  .command('notify:test')
  .description('Send a test notification via backend')
  .argument('<sessionId>', 'session ID to notify')
  .action(async (sessionId: string) => {
    await notifySession(sessionId, 'Ashral test', 'If you see this, notifications are working.', 'high');
    process.stderr.write('[ashral] Done.\n');
  });

program.parse(process.argv);

#!/usr/bin/env node
import { Command } from 'commander';
import { runSession } from './runner/runSession';
import { ClaudeAdapter } from './adapters/claudeAdapter';
import { CodexAdapter } from './adapters/codexAdapter';
import { BackendNotifier } from './notifications/backendNotifier';
import { loadEnvFile } from './config/loadEnv';
import { showSessionQr } from './qr/showSessionQr';
import { createSession, deleteSession, notifySession, OutdatedClientError } from './api/backendClient';
import { randomUUID } from 'crypto'; // fallback when backend is unreachable
import type { AshralEvent } from './types/events';

const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// ── Event handler ─────────────────────────────────────────────────────────────

function makeEventHandler(
  sessionId: string,
  sessionName: string | undefined,
): (event: AshralEvent) => void {
  const label = sessionName ? `"${sessionName}"` : 'session';
  const notifier = new BackendNotifier(sessionId);

  return function onEvent(event: AshralEvent): void {
    if (event.type === 'output') return;

    switch (event.type) {
      case 'status_changed': {
        if (event.to === 'waiting_for_input') {
          notifier.send({
            title: label,
            body: 'AI is waiting for your input.',
            priority: 'high',
            rawText: event.text,
          });
        } else if (event.to === 'approval_required') {
          notifier.send({
            title: label,
            body: 'AI is waiting for your approval.',
            priority: 'urgent',
            rawText: event.text,
          });
        } else if (event.to === 'error') {
          notifier.send({
            title: label,
            body: 'AI encountered an error.',
            priority: 'high',
            rawText: event.text,
          });
        }
        break;
      }

      case 'completed':
        notifier.send({
          title: label,
          body: 'Session completed.',
          priority: 'normal',
        });
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
  try {
    adapter.verify();
  } catch (err) {
    process.stderr.write(`\n${RED}[ashral] ${err instanceof Error ? err.message : err}${RESET}\n\n`);
    process.exit(1);
  }

  let sessionId: string = randomUUID(); // fallback if backend is unreachable

  try {
    sessionId = await createSession({ agent: adapter.agentName, name: options.name ?? adapter.agentName });
  } catch (err) {
    if (err instanceof OutdatedClientError) {
      process.stderr.write(`\n${RED}[ashral] ${err.message}${RESET}\n\n`);
      process.exit(1);
    }
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

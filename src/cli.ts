#!/usr/bin/env node
import { Command } from 'commander';
import { runSession } from './runner/runSession';
import { ClaudeAdapter } from './adapters/claudeAdapter';
import { NtfyNotifier } from './notifications/ntfyNotifier';
import type { Notifier } from './notifications/notifier';
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

// ── Event handler factory ────────────────────────────────────────────────────
// Returns an onEvent callback. Logs to stderr and fires push notifications
// when Claude needs attention.

function makeEventHandler(
  sessionName: string | undefined,
  notifier: Notifier | null,
): (event: AshralEvent) => void {
  const tag = `${DIM}[ashral]${RESET}`;
  const label = sessionName ? `"${sessionName}"` : 'session';

  return function onEvent(event: AshralEvent): void {
    // Raw output is already mirrored to stdout — skip it here
    if (event.type === 'output') return;

    const ts = `${DIM}${timestamp()}${RESET}`;

    switch (event.type) {
      case 'status_changed': {
        process.stderr.write(
          `\n${tag} ${ts} ${CYAN}status${RESET}  ${event.from} → ${event.to}\n`,
        );

        if (!notifier) break;

        // Notify when Claude needs the user's attention
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

// ── Notifier setup ────────────────────────────────────────────────────────────
// Resolves a notifier from --notify-url flag or ASHRAL_NTFY_URL env var.
// Returns null (silent) if neither is set.

function resolveNotifier(flagUrl: string | undefined): Notifier | null {
  const url = flagUrl ?? process.env.ASHRAL_NTFY_URL;
  if (!url) return null;
  return new NtfyNotifier(url);
}

// ── CLI definition ────────────────────────────────────────────────────────────

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
  .option(
    '--notify-url <url>',
    'ntfy.sh topic URL for push notifications (or set ASHRAL_NTFY_URL)',
  )
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (options: { name?: string; notifyUrl?: string }, command: Command) => {
    const passthroughArgs = command.args;
    const adapter = new ClaudeAdapter();
    const notifier = resolveNotifier(options.notifyUrl);

    if (options.name) {
      process.stderr.write(`\n[ashral] Starting session: ${options.name}\n`);
    }
    if (notifier) {
      process.stderr.write(`[ashral] Push notifications enabled.\n`);
    }
    process.stderr.write('\n');

    try {
      await runSession({
        adapter,
        name: options.name,
        passthroughArgs,
        onEvent: makeEventHandler(options.name, notifier),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashral] Fatal: ${message}\n`);
      process.exit(1);
    }
  });

program.parse(process.argv);

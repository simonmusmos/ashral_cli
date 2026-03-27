#!/usr/bin/env node
import { Command } from 'commander';
import { runSession } from './runner/runSession';
import { ClaudeAdapter } from './adapters/claudeAdapter';
import { NtfyNotifier } from './notifications/ntfyNotifier';
import { FirebaseNotifier } from './notifications/firebaseNotifier';
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
// Priority: Firebase (if credentials + token are set) → ntfy → silent.
// Config is read from env vars so credentials never appear in shell history.
//
// Firebase env vars:
//   ASHRAL_FIREBASE_SERVICE_ACCOUNT  path to service account JSON, or the JSON string itself
//   ASHRAL_FCM_TOKEN                 device registration token from the mobile app
//
// ntfy env var:
//   ASHRAL_NTFY_URL                  e.g. https://ntfy.sh/your-topic

function resolveNotifier(ntfyFlagUrl: string | undefined): Notifier | null {
  const serviceAccount = process.env.ASHRAL_FIREBASE_SERVICE_ACCOUNT;
  const deviceToken = process.env.ASHRAL_FCM_TOKEN;

  if (serviceAccount && deviceToken) {
    try {
      return new FirebaseNotifier({ serviceAccount, deviceToken });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashral] Firebase init error: ${msg}\n`);
      process.stderr.write(`[ashral] Falling back to ntfy if configured.\n`);
    }
  }

  const ntfyUrl = ntfyFlagUrl ?? process.env.ASHRAL_NTFY_URL;
  if (ntfyUrl) return new NtfyNotifier(ntfyUrl);

  return null;
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
      const provider = notifier instanceof FirebaseNotifier ? 'Firebase' : 'ntfy';
      process.stderr.write(`[ashral] Push notifications enabled (${provider}).\n`);
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

#!/usr/bin/env node
import { Command } from 'commander';
import { runSession } from './runner/runSession';
import { ClaudeAdapter } from './adapters/claudeAdapter';
import type { AshralEvent } from './types/events';

// ── Event logger ────────────────────────────────────────────────────────────
// All structured events go to stderr so they don't corrupt Claude's stdout.
// Swap this function for a WebSocket emitter or log sink later.

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';

function timestamp(): string {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

function logEvent(event: AshralEvent): void {
  // Raw output is already mirrored to stdout — skip it here
  if (event.type === 'output') return;

  const ts = `${DIM}${timestamp()}${RESET}`;
  const tag = `${DIM}[ashral]${RESET}`;

  switch (event.type) {
    case 'status_changed':
      process.stderr.write(
        `\n${tag} ${ts} ${CYAN}status${RESET}  ${event.from} → ${event.to}\n`,
      );
      break;
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
}

// ── CLI definition ───────────────────────────────────────────────────────────

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
  // Allow unknown options and extra args so everything after -- is forwarded
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (options: { name?: string }, command: Command) => {
    // Collect passthrough args: everything after the known --name option.
    // Convention: use -- to explicitly separate ashral flags from agent flags.
    //   ashral run claude --name "Meetz" -- --model opus --verbose
    const passthroughArgs = command.args;

    const adapter = new ClaudeAdapter();

    if (options.name) {
      process.stderr.write(`\n[ashral] Starting session: ${options.name}\n\n`);
    }

    try {
      await runSession({
        adapter,
        name: options.name,
        passthroughArgs,
        onEvent: logEvent,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashral] Fatal: ${message}\n`);
      process.exit(1);
    }
  });

program.parse(process.argv);

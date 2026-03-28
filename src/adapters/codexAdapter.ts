import { BaseAdapter, type AdapterCommand } from './baseAdapter';
import type { SessionStatus } from '../types/session';

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B[@-_][0-?]*[ -/]*[@-~]/g;

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_RE, '');
}

// Codex requires the user to approve shell commands before execution
const APPROVAL_PATTERNS = [
  /allow\s+(this\s+)?command/i,
  /run\s+this\s+command/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /yes\/no/i,
  /approve|deny/i,
  /do you want to/i,
  /press enter to confirm/i,
];

// Codex is waiting for the user to type
const WAITING_PATTERNS = [
  /^>\s*$/m,
  /\?\s*$/m,
  /^\s*>\s*\d+\./m,       // numbered choice menu
  /^\s*\d+\.\s+\S/m,      // numbered list options
  /type something/i,
  /what would you like/i,
  /how can i (help|assist)/i,
  /what('s| is) (the |your )?next/i,
  /codex[>\s]*$/im,        // "codex>" style prompt
  /waiting for input/i,
];

// Codex is actively doing work
const RUNNING_PATTERNS = [
  /running|executing|calling/i,
  /writing|creating|updating|deleting/i,
  /reading|fetching|searching/i,
  /thinking|planning/i,
  /applying (changes|patch)/i,
];

const ERROR_PATTERNS = [
  /^error:/im,
  /fatal error/i,
  /uncaught exception/i,
  /command not found/i,
  /permission denied/i,
  /ENOENT|EACCES|ECONNREFUSED/,
  /api (key|error|quota)/i,
];

export class CodexAdapter extends BaseAdapter {
  readonly agentName = 'codex';

  getCommand(passthroughArgs: string[]): AdapterCommand {
    // On Windows, npm CLIs are installed as .cmd wrappers
    const command = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    return { command, args: passthroughArgs };
  }

  detectStatus(raw: string, currentStatus: SessionStatus): SessionStatus | null {
    if (currentStatus === 'completed') return null;

    const text = stripAnsi(raw);

    if (this.matches(text, APPROVAL_PATTERNS)) return 'approval_required';
    if (this.matches(text, ERROR_PATTERNS)) return 'error';
    if (this.matches(text, WAITING_PATTERNS)) return 'waiting_for_input';

    if (
      this.matches(text, RUNNING_PATTERNS) &&
      (currentStatus === 'waiting_for_input' || currentStatus === 'approval_required')
    ) {
      return 'running';
    }

    return null;
  }

  private matches(text: string, patterns: RegExp[]): boolean {
    return patterns.some((p) => p.test(text));
  }
}

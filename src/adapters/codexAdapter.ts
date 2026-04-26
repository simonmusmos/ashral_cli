import { BaseAdapter, type AdapterCommand } from './baseAdapter';
import type { SessionStatus } from '../types/session';

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B[@-_][0-?]*[ -/]*[@-~]/g;

/**
 * Full TUI-aware cleaning: converts cursor-movement codes to newlines so
 * pattern matching works on ink-rendered output. Plain stripAnsi() leaves
 * \x1b[H, \x1b[2J etc. in place, which means the ">" prompt never appears
 * at the start of a line and WAITING_PATTERNS never fire.
 */
function cleanForDetection(raw: string): string {
  return raw
    .replace(/\x1B\[(\d*)C/g, (_, n) => ' '.repeat(Math.max(1, parseInt(n || '1', 10))))
    .replace(/\x1B\[(?:\d+;)*\d*[Hf]/g, '\n')
    .replace(/\x1B\[\d*[BE]/g, '\n')
    .replace(/\x1B\[\d*G/g, '\n')
    .replace(ANSI_RE, '')
    .replace(/\r/g, '\n');
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

// Codex session IDs: OpenAI thread_ prefix or a plain UUID
const CODEX_SESSION_RE = /[Ss]ession[:\s#]+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|thread_\S+)/;
const CODEX_UUID_RE = /\b([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/;

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
  readonly usesOpenAIProxy = true;

  getCommand(passthroughArgs: string[]): AdapterCommand {
    // On Windows, npm CLIs are installed as .cmd wrappers
    const command = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    return { command, args: passthroughArgs };
  }

  detectStatus(raw: string, currentStatus: SessionStatus): SessionStatus | null {
    if (currentStatus === 'completed') return null;

    const text = cleanForDetection(raw);

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

  extractAgentSessionId(raw: string): string | null {
    const contextual = CODEX_SESSION_RE.exec(raw);
    if (contextual) return contextual[1];
    const any = CODEX_UUID_RE.exec(raw);
    return any ? any[1] : null;
  }

  private matches(text: string, patterns: RegExp[]): boolean {
    return patterns.some((p) => p.test(text));
  }
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaudeAdapter = void 0;
const baseAdapter_1 = require("./baseAdapter");
// Strip ANSI/VT escape sequences so regex patterns match clean text
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B[@-_][0-?]*[ -/]*[@-~]/g;
function stripAnsi(raw) {
    return raw.replace(ANSI_RE, '');
}
/**
 * Heuristic patterns extracted from Claude Code's real terminal output.
 *
 * These are intentionally conservative — a false negative (missed transition)
 * is safer than a false positive (wrong state). Tune as you collect more samples.
 */
// Claude is prompting the user to approve a tool call or destructive action
const APPROVAL_PATTERNS = [
    /do you want to/i,
    /allow this/i,
    /\(y\/n\)/i,
    /\[y\/n\]/i,
    /yes\/no/i,
    /press enter to confirm/i,
    /approve|deny/i,
];
// Claude is waiting for the user to type a new message
const WAITING_PATTERNS = [
    /^>\s*$/m, // bare ">" prompt line
    /\?\s*$/m, // line ending with "?" — note: needs `m` flag so $ matches end-of-line, not end-of-string
    /^\s*>\s*\d+\./m, // Claude's numbered-choice menu cursor: "> 1. Option"
    /^\s*\d+\.\s+\S/m, // numbered list of options presented to the user
    /type something/i, // Claude Code's "5. Type something." freeform option
    /what would you like/i,
    /how can i (help|assist)/i,
    /human:\s*$/im,
];
// Claude is actively doing work
const RUNNING_PATTERNS = [
    /running|executing|calling tool/i,
    /writing|creating|updating|deleting/i,
    /reading|fetching|searching/i,
    /thinking\.\.\./i,
];
// Something clearly went wrong
const ERROR_PATTERNS = [
    /^error:/im,
    /fatal error/i,
    /uncaught exception/i,
    /command not found/i,
    /permission denied/i,
    /ENOENT|EACCES|ECONNREFUSED/,
];
class ClaudeAdapter extends baseAdapter_1.BaseAdapter {
    constructor() {
        super(...arguments);
        this.agentName = 'claude';
    }
    getCommand(passthroughArgs) {
        // On Windows, npm CLIs are installed as .cmd wrappers — node-pty needs the
        // explicit extension since it doesn't go through the shell to resolve it.
        const command = process.platform === 'win32' ? 'claude.cmd' : 'claude';
        return {
            command,
            args: passthroughArgs,
            // No extra env needed — claude picks up the caller's environment
        };
    }
    detectStatus(raw, currentStatus) {
        // Never transition out of completed/error via output alone
        if (currentStatus === 'completed')
            return null;
        const text = stripAnsi(raw);
        if (this.matches(text, APPROVAL_PATTERNS))
            return 'approval_required';
        if (this.matches(text, ERROR_PATTERNS))
            return 'error';
        if (this.matches(text, WAITING_PATTERNS))
            return 'waiting_for_input';
        // Transition back to running only if we were previously paused
        if (this.matches(text, RUNNING_PATTERNS) &&
            (currentStatus === 'waiting_for_input' || currentStatus === 'approval_required')) {
            return 'running';
        }
        return null;
    }
    matches(text, patterns) {
        return patterns.some((p) => p.test(text));
    }
}
exports.ClaudeAdapter = ClaudeAdapter;
//# sourceMappingURL=claudeAdapter.js.map
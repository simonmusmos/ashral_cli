"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSession = runSession;
const pty = __importStar(require("node-pty"));
const sessionState_1 = require("./sessionState");
const anthropicProxy_1 = require("../proxy/anthropicProxy");
const backendClient_1 = require("../api/backendClient");
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B[@-_][0-?]*[ -/]*[@-~]/g;
/**
 * Rolling buffer of the last N clean lines of PTY output.
 * Used only for status detection and push notification body extraction.
 */
function makeOutputBuffer() {
    const lines = [];
    const MAX = 80;
    function push(raw) {
        const cleaned = raw
            // ink uses cursor-forward (\x1b[nC) for spaces — restore them before stripping
            .replace(/\x1B\[(\d*)C/g, (_, n) => ' '.repeat(Math.max(1, parseInt(n || '1', 10))))
            // Cursor-position and cursor-down codes imply a new line — convert before stripping
            .replace(/\x1B\[(?:\d+;)*\d*[Hf]/g, '\n') // \x1b[row;colH / \x1b[H → newline
            .replace(/\x1B\[\d*[BE]/g, '\n') // cursor down / next line → newline
            .replace(/\x1B\[\d*G/g, '\n') // cursor to column (start of line) → newline
            .replace(ANSI_RE, '') // strip remaining escape sequences
            .replace(/\r/g, '\n') // bare \r → newline
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 1);
        lines.push(...cleaned);
        if (lines.length > MAX)
            lines.splice(0, lines.length - MAX);
    }
    function extractBody() {
        const candidates = lines
            .filter((l) => !l.includes('[ashral]'))
            .filter((l) => !/^\d+\.\s/.test(l))
            .filter((l) => !/^[╭╰╮╯│─❯>\s□↓↑←→]+$/.test(l))
            .filter((l) => !/→\s*\w+_\w+/.test(l));
        const question = [...candidates].reverse().find((l) => l.endsWith('?'));
        const body = question ?? candidates[candidates.length - 1];
        return body ? body.slice(0, 200) : undefined;
    }
    /** Extract numbered option lines from the buffer, e.g. ["1. Write code", "2. Review code"] */
    function extractOptions() {
        const seen = new Set();
        const result = [];
        for (const line of lines) {
            // Match optional ❯ or > cursor prefix, then "N. Label text"
            const match = /^[❯>]?\s*(\d+\.\s+\S.*)$/.exec(line);
            if (!match)
                continue;
            const option = match[1].trim();
            if (!seen.has(option)) {
                seen.add(option);
                result.push(option);
            }
        }
        return result.slice(0, 10);
    }
    function clear() {
        lines.length = 0;
    }
    return { push, extractBody, extractOptions, clear };
}
/**
 * Spawns the agent inside a PTY, bridges all I/O, and drives the session
 * state machine. Resolves when the agent process exits.
 */
async function runSession(options) {
    const { adapter, name, sessionId, passthroughArgs, onEvent } = options;
    const cwd = process.cwd();
    const { columns = 80, rows = 24 } = process.stdout;
    const state = new sessionState_1.SessionState(adapter.agentName, name, cwd, onEvent, sessionId);
    const config = adapter.getCommand(passthroughArgs);
    // Start the transparent Anthropic proxy — Claude Code's API traffic flows
    // through it so we can capture clean assistant text without touching the PTY.
    const proxy = await (0, anthropicProxy_1.startAnthropicProxy)(state.id).catch(() => null);
    const baseEnv = { ...process.env, ...(config.env ?? {}) };
    const env = proxy
        ? { ...baseEnv, ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}` }
        : baseEnv;
    const term = pty.spawn(config.command, config.args, {
        name: 'xterm-color',
        cols: columns,
        rows,
        cwd,
        env,
    });
    state.transition('running');
    const buffer = makeOutputBuffer();
    // ── Spurious-running suppression ─────────────────────────────────────────────
    // After entering waiting_for_input/approval_required, ink often emits cursor-
    // movement output that the adapter mis-detects as 'running'. Suppress those
    // PTY-sourced 'running' transitions for a short window so the backend retains
    // pendingAction long enough for Flutter to poll it.
    let suppressRunningUntil = 0;
    // ── Remote response polling ──────────────────────────────────────────────────
    // When the agent is waiting for input and the user responds via the mobile app,
    // we poll the backend and write the response directly into the PTY.
    let responsePoller = null;
    function startResponsePolling() {
        if (responsePoller)
            return;
        responsePoller = setInterval(async () => {
            if (state.status !== 'waiting_for_input' && state.status !== 'approval_required') {
                stopResponsePolling();
                return;
            }
            try {
                const response = await (0, backendClient_1.getSessionResponse)(state.id);
                if (response) {
                    stopResponsePolling();
                    suppressRunningUntil = 0; // Legitimate transition — lift suppression
                    buffer.clear(); // Clear stale options so they don't bleed into the next question
                    await writeToPty(response);
                    state.transition('running');
                }
            }
            catch {
                // ignore — polling is best-effort
            }
        }, 2000);
    }
    function stopResponsePolling() {
        if (responsePoller) {
            clearInterval(responsePoller);
            responsePoller = null;
        }
    }
    async function writeToPty(response) {
        const lower = response.toLowerCase().trim();
        const approvalMap = {
            approve: 'y',
            allow: 'y',
            yes: 'y',
            deny: 'n',
            no: 'n',
        };
        if (approvalMap[lower]) {
            term.write(approvalMap[lower] + '\r');
            return;
        }
        // Numbered option — navigate with arrow keys, one per tick, so ink-select-input
        // processes each keypress before the next arrives.
        const num = parseInt(response.trim(), 10);
        if (!isNaN(num) && num >= 1) {
            for (let i = 1; i < num; i++) {
                term.write('\x1B[B');
                await new Promise(resolve => setTimeout(resolve, 80));
            }
            term.write('\r');
            return;
        }
        term.write(response + '\r');
    }
    // ── Output: mirror PTY → stdout, inspect for state changes ─────────────────
    term.onData((data) => {
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
            // Suppress PTY-sourced 'running' detections right after waiting_for_input
            // to prevent the backend from clearing pendingAction before Flutter polls it.
            if (next === 'running' && Date.now() < suppressRunningUntil) {
                return;
            }
            const body = buffer.extractBody();
            state.transition(next, body);
            if (next === 'waiting_for_input' || next === 'approval_required') {
                suppressRunningUntil = Date.now() + 5000; // Hold off spurious running for 5s
                // Delay extraction so the full prompt has time to finish rendering into the buffer
                setTimeout(() => {
                    const options = buffer.extractOptions();
                    const question = buffer.extractBody();
                    void (0, backendClient_1.updateSessionStatus)(state.id, 'waiting_for_input', {
                        question,
                        // Fall back to approve/deny for approval prompts with no detectable numbered options
                        options: options.length > 0 ? options : (next === 'approval_required' ? ['approve', 'deny'] : []),
                    }).catch(() => { });
                    startResponsePolling();
                }, 500);
            }
            else {
                suppressRunningUntil = 0;
                stopResponsePolling();
            }
        }
    });
    // ── Input: forward stdin → PTY ──────────────────────────────────────────────
    const isTTY = process.stdin.isTTY ?? false;
    if (isTTY)
        process.stdin.setRawMode(true);
    process.stdin.resume();
    const onStdinData = (chunk) => {
        term.write(chunk.toString('binary'));
        if (state.status === 'waiting_for_input' || state.status === 'approval_required') {
            stopResponsePolling();
            suppressRunningUntil = 0; // Legitimate transition — lift suppression
            buffer.clear();
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
    function teardown() {
        stopResponsePolling();
        process.stdin.removeListener('data', onStdinData);
        process.stdout.removeListener('resize', onResize);
        if (isTTY)
            process.stdin.setRawMode(false);
        process.stdin.pause();
    }
    return new Promise((resolve) => {
        term.onExit(async ({ exitCode, signal }) => {
            teardown();
            await proxy?.stop();
            if (signal && exitCode !== 0) {
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
    });
}
//# sourceMappingURL=runSession.js.map
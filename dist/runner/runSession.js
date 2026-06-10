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
const fs = __importStar(require("fs"));
const sessionState_1 = require("./sessionState");
const anthropicProxy_1 = require("../proxy/anthropicProxy");
const openaiProxy_1 = require("../proxy/openaiProxy");
const backendClient_1 = require("../api/backendClient");
const DEBUG_LOG = '/tmp/ashral-debug.log';
function dbg(msg) {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
}
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B[@-_][0-?]*[ -/]*[@-~]/g;
/**
 * Rolling buffer of the last N clean lines of PTY output.
 * Used only for status detection and push notification body extraction.
 */
function makeOutputBuffer() {
    const lines = [];
    const MAX = 80;
    function push(raw) {
        const split = raw
            // ink uses cursor-forward (\x1b[nC) for spaces — restore them before stripping
            .replace(/\x1B\[(\d*)C/g, (_, n) => ' '.repeat(Math.max(1, parseInt(n || '1', 10))))
            // Cursor-position and cursor-down codes imply a new line — convert before stripping
            .replace(/\x1B\[(?:\d+;)*\d*[Hf]/g, '\n') // \x1b[row;colH / \x1b[H → newline
            .replace(/\x1B\[\d*[BE]/g, '\n') // cursor down / next line → newline
            .replace(/\x1B\[\d*G/g, '\n') // cursor to column (start of line) → newline
            .replace(ANSI_RE, '') // strip remaining escape sequences
            .replace(/\r/g, '\n') // bare \r → newline
            .split('\n')
            .map((l) => l.trim());
        // Claude Code renders its suggested action as '>' then cursor-to-col-1 then the
        // suggestion text, e.g. "> Commit this...". After our \x1b[G→\n conversion that
        // becomes two lines: '>' and 'Commit this...'. Re-join them so the '> ' prefix
        // filter in extractBody() treats the whole thing as a suggestion and ignores it.
        const rejoined = [];
        for (let i = 0; i < split.length; i++) {
            if ((split[i] === '>' || split[i] === '❯') && i + 1 < split.length && split[i + 1].length > 0) {
                rejoined.push('> ' + split[i + 1]);
                i++;
            }
            else {
                rejoined.push(split[i]);
            }
        }
        lines.push(...rejoined.filter((l) => l.length > 1));
        if (lines.length > MAX)
            lines.splice(0, lines.length - MAX);
    }
    function extractBody() {
        const candidates = lines
            .filter((l) => !l.includes('[ashral]'))
            .filter((l) => !/^\d+\.\s/.test(l))
            .filter((l) => !/^[╭╰╮╯│─❯>\s□↓↑←→]+$/.test(l))
            .filter((l) => !/→\s*\w+_\w+/.test(l))
            .filter((l) => !l.trimStart().startsWith('> ')); // Claude Code suggested-action lines
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
 * Strips ANSI/TUI escape codes from raw PTY output and deduplicates
 * consecutive identical lines. Used to save Codex output to the backend
 * when the Anthropic proxy is not active.
 */
// Lines that are purely TUI chrome: box-drawing, arrows, navigation cursors
const TUI_CHROME_RE = /^[╭╰╮╯│─╴╷╸╹❯›>\s□↓↑←→·•◆◇▶▷⏎⏏✓✗●○◉]+$/u;
// Lines that look like a terminal status bar: filesystem path + model name
const STATUS_BAR_RE = /^[~\/][^\s]*\s+(?:gpt|claude|o1|o3|gemini|mistral|llama|codex|default|fast|slow)/i;
function stripPtyForStorage(raw) {
    const text = raw
        // OSC sequences: \x1b]...\x07 or \x1b]...\x1b\\ — not caught by ANSI_RE
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        // DEC private mode and other unhandled sequences
        .replace(/\x1b\[[\x3c-\x3f][\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
        .replace(/\x1B\[(\d*)C/g, (_, n) => ' '.repeat(Math.max(1, parseInt(n || '1', 10))))
        .replace(/\x1B\[(?:\d+;)*\d*[Hf]/g, '\n')
        .replace(/\x1B\[\d*[BE]/g, '\n')
        .replace(/\x1B\[\d*G/g, '\n')
        .replace(ANSI_RE, '')
        // Strip any remaining bare ESC bytes
        .replace(/\x1b[^\x1b]?/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    const deduped = [];
    for (const line of text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 1)
        .filter((l) => !TUI_CHROME_RE.test(l))
        .filter((l) => !STATUS_BAR_RE.test(l))) {
        if (deduped.length === 0 || deduped[deduped.length - 1] !== line)
            deduped.push(line);
    }
    return deduped.join('\n').trim();
}
const PTY_CHUNK_MAX = 14000;
async function saveChunked(sessionId, text, stream) {
    for (let i = 0; i < text.length; i += PTY_CHUNK_MAX) {
        await (0, backendClient_1.appendSessionOutput)(sessionId, text.slice(i, i + PTY_CHUNK_MAX), stream).catch(() => { });
    }
}
/**
 * Spawns the agent inside a PTY, bridges all I/O, and drives the session
 * state machine. Resolves when the agent process exits.
 */
async function runSession(options) {
    const { adapter, name, sessionId, passthroughArgs, onEvent } = options;
    dbg(`runSession start adapter=${adapter.agentName}`);
    const cwd = process.cwd();
    const { columns = 80, rows = 24 } = process.stdout;
    const state = new sessionState_1.SessionState(adapter.agentName, name, cwd, onEvent, sessionId);
    const config = adapter.getCommand(passthroughArgs);
    // If the caller passed --resume <id>, we already know the agent session ID
    const resumeIdx = passthroughArgs.indexOf('--resume');
    const preKnownAgentSessionId = resumeIdx >= 0 ? passthroughArgs[resumeIdx + 1] : null;
    if (preKnownAgentSessionId) {
        void (0, backendClient_1.saveAgentSessionId)(state.id, preKnownAgentSessionId).catch(() => { });
    }
    // Start whichever API proxy this adapter needs.
    // Each proxy intercepts the agent's AI traffic and saves clean text to the backend,
    // which is far more reliable than scraping raw PTY output.
    const anthropicProxy = adapter.usesAnthropicProxy
        ? await (0, anthropicProxy_1.startAnthropicProxy)(state.id, cwd).catch(() => null)
        : null;
    const openaiProxy = adapter.usesOpenAIProxy
        ? await (0, openaiProxy_1.startOpenAIProxy)(state.id).catch(() => null)
        : null;
    // For Codex (Rust binary), OPENAI_BASE_URL env var is ignored. Patch the real
    // ~/.codex/config.toml to inject openai_base_url pointing at our proxy. The
    // restore function undoes the patch after Codex exits.
    const codexRestoreConfig = openaiProxy
        ? await (0, openaiProxy_1.patchCodexConfig)(openaiProxy.port).catch(() => null)
        : null;
    dbg(`proxies anthropic=${anthropicProxy?.port ?? 'off'} openai=${openaiProxy?.port ?? 'off'} codexConfig=${codexRestoreConfig ? 'patched' : 'off'}`);
    // proxyActive: true when an API-level proxy is handling saves for this adapter.
    // When false, fall back to accumulating raw PTY output and stripping TUI escapes.
    const proxyActive = (anthropicProxy !== null && adapter.usesAnthropicProxy) ||
        (openaiProxy !== null && adapter.usesOpenAIProxy);
    let ptyOutputAccum = '';
    // Don't save the pre-conversation startup flush — it's pure TUI chrome.
    // Flipped to true the first time the user sends a message.
    let hasUserSentMessage = false;
    const baseEnv = { ...process.env, ...(config.env ?? {}) };
    const env = {
        ...baseEnv,
        ...(anthropicProxy ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicProxy.port}` } : {}),
    };
    const term = pty.spawn(config.command, config.args, {
        name: 'xterm-color',
        cols: columns,
        rows,
        cwd,
        env,
    });
    state.transition('running');
    const buffer = makeOutputBuffer();
    // ── Agent session ID detection ───────────────────────────────────────────────
    // Accumulates early PTY output (up to 5000 stripped chars) and scans for the
    // agent's internal session ID so we can persist it for later resumption.
    let agentSessionIdSaved = !!preKnownAgentSessionId;
    let startupBuf = '';
    const STARTUP_SCAN_LIMIT = 5000;
    // ── Spurious-running suppression ─────────────────────────────────────────────
    // After entering waiting_for_input/approval_required, ink often emits cursor-
    // movement output that the adapter mis-detects as 'running'. Suppress those
    // PTY-sourced 'running' transitions for a short window so the backend retains
    // pendingAction long enough for Flutter to poll it.
    let suppressRunningUntil = 0;
    // ── Remote response polling ──────────────────────────────────────────────────
    // Always-on poller: handles pending action responses (waiting_for_input /
    // approval_required) AND proactive messages sent from the mobile app while the
    // agent is running. Started once at session launch, stopped only on teardown.
    let responsePoller = null;
    startResponsePolling();
    function startResponsePolling() {
        if (responsePoller)
            return;
        responsePoller = setInterval(async () => {
            try {
                const response = await (0, backendClient_1.getSessionResponse)(state.id);
                if (!response)
                    return;
                if (state.status === 'waiting_for_input' || state.status === 'approval_required') {
                    suppressRunningUntil = 0;
                    buffer.clear();
                    await writeToPty(response);
                    state.transition('running');
                }
                else if (state.status === 'running') {
                    // Proactive message sent from mobile while agent is working
                    await writeToPty(response);
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
        // For non-proxy adapters: save the user message and reset the output
        // accumulator so the next AI response chunk starts clean.
        dbg(`writeToPty proxyActive=${proxyActive} response="${response.slice(0, 40)}"`);
        if (!proxyActive) {
            hasUserSentMessage = true;
            (0, backendClient_1.appendSessionOutput)(state.id, response, 'stderr')
                .then(() => dbg('saved user msg ok'))
                .catch((e) => dbg(`save user msg FAILED: ${e}`));
            ptyOutputAccum = '';
        }
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
        // Write text first, then wait a tick before sending Enter.
        // ink-based CLIs (e.g. Codex) batch React state updates — if the CR
        // arrives in the same chunk as the text, the onSubmit handler fires
        // before the text state is committed, producing a blank submit.
        term.write(response);
        await new Promise(resolve => setTimeout(resolve, 80));
        term.write('\r');
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
        // Accumulate raw PTY output for adapters without an active Anthropic proxy
        if (!proxyActive)
            ptyOutputAccum += data;
        if (!agentSessionIdSaved && startupBuf.length < STARTUP_SCAN_LIMIT) {
            startupBuf += data.replace(ANSI_RE, '');
            const detected = adapter.extractAgentSessionId(startupBuf);
            if (detected) {
                agentSessionIdSaved = true;
                dbg(`agentSessionId detected: ${detected}`);
                void (0, backendClient_1.saveAgentSessionId)(state.id, detected).catch(() => { });
            }
            else if (startupBuf.length >= STARTUP_SCAN_LIMIT) {
                dbg(`agentSessionId NOT found after ${STARTUP_SCAN_LIMIT} chars. buf preview: "${startupBuf.slice(0, 200).replace(/\n/g, '↵')}"`);
            }
        }
        const next = adapter.detectStatus(data, state.status);
        if (next !== null) {
            dbg(`detectStatus: ${state.status} → ${next}`);
            // Suppress PTY-sourced 'running' detections right after waiting_for_input
            // to prevent the backend from clearing pendingAction before Flutter polls it.
            if (next === 'running' && Date.now() < suppressRunningUntil) {
                return;
            }
            const body = buffer.extractBody();
            state.transition(next, body);
            if (next === 'waiting_for_input' || next === 'approval_required') {
                suppressRunningUntil = Date.now() + 5000; // Hold off spurious running for 5s
                // For non-proxy adapters: flush the accumulated PTY output as AI response.
                // Skip the very first flush (startup screen before any user interaction).
                dbg(`status→waiting proxyActive=${proxyActive} hasUser=${hasUserSentMessage} accumLen=${ptyOutputAccum.length}`);
                if (!proxyActive && hasUserSentMessage && ptyOutputAccum) {
                    const cleaned = stripPtyForStorage(ptyOutputAccum);
                    ptyOutputAccum = '';
                    dbg(`stripped cleanedLen=${cleaned.length} preview="${cleaned.slice(0, 100).replace(/\n/g, '↵')}"`);
                    if (cleaned) {
                        saveChunked(state.id, cleaned, 'stdout')
                            .then(() => dbg('saveChunked ok'))
                            .catch((e) => dbg(`saveChunked FAILED: ${e}`));
                    }
                    else {
                        dbg('cleaned is empty — nothing saved');
                    }
                }
                // Delay extraction so the full prompt has time to finish rendering into the buffer.
                // ink.js renders approval dialogs incrementally — 1200ms is enough for even slow paints.
                setTimeout(() => {
                    const options = buffer.extractOptions();
                    const question = buffer.extractBody();
                    void (0, backendClient_1.updateSessionStatus)(state.id, 'waiting_for_input', {
                        question,
                        // Fall back to approve/deny for approval prompts with no detectable numbered options
                        options: options.length > 0 ? options : (next === 'approval_required' ? ['approve', 'deny'] : []),
                    }).catch(() => { });
                    startResponsePolling();
                }, 1200);
            }
            else {
                suppressRunningUntil = 0;
                // Poller stays active for proactive messages from mobile
            }
        }
    });
    // ── Input: forward stdin → PTY ──────────────────────────────────────────────
    const isTTY = process.stdin.isTTY ?? false;
    if (isTTY)
        process.stdin.setRawMode(true);
    process.stdin.resume();
    // Returns true only for chunks that represent deliberate user keystrokes.
    // Terminal emulators send focus/blur events (\x1b[I / \x1b[O) and other
    // control sequences as stdin data — those must not be treated as user input
    // or they stop the response poller and strand mobile sessions.
    function isRealUserInput(chunk) {
        for (const byte of chunk) {
            if (byte >= 0x20 && byte <= 0x7e)
                return true; // printable ASCII
            if (byte === 0x0d || byte === 0x0a)
                return true; // Enter
            if (byte === 0x7f || byte === 0x08)
                return true; // Backspace/DEL
            if (byte === 0x03 || byte === 0x04)
                return true; // Ctrl+C / Ctrl+D
        }
        return false;
    }
    const onStdinData = (chunk) => {
        term.write(chunk.toString('binary'));
        if (isRealUserInput(chunk) &&
            (state.status === 'waiting_for_input' || state.status === 'approval_required')) {
            stopResponsePolling();
            suppressRunningUntil = 0; // Legitimate transition — lift suppression
            buffer.clear();
            // Mirror writeToPty: mark that a real message was sent so the next AI
            // response gets saved, and reset the accumulator so only the new response
            // is captured (not the full TUI history from before this message).
            if (!proxyActive) {
                hasUserSentMessage = true;
                ptyOutputAccum = '';
                dbg('stdin: hasUserSentMessage=true accumulator reset');
            }
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
            await anthropicProxy?.stop();
            await openaiProxy?.stop();
            if (codexRestoreConfig)
                await codexRestoreConfig();
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
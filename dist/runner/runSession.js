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
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]|\x1B[@-_][0-?]*[ -/]*[@-~]/g;
/**
 * Rolling buffer of the last N clean lines of PTY output.
 * Used only for status detection and push notification body extraction.
 */
function makeOutputBuffer() {
    const lines = [];
    const MAX = 40;
    function push(raw) {
        const cleaned = raw
            .replace(ANSI_RE, '')
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
    return { push, extractBody };
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
            state.transition(next, buffer.extractBody());
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
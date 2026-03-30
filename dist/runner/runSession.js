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
    // Merge adapter env overrides on top of the current environment
    const env = { ...process.env, ...(config.env ?? {}) };
    const term = pty.spawn(config.command, config.args, {
        name: 'xterm-color',
        cols: columns,
        rows,
        cwd,
        env,
    });
    state.transition('running');
    // ── Output: mirror PTY → stdout, inspect for state changes ─────────────────
    term.onData((data) => {
        // Write raw (ANSI-preserved) data so the terminal renders correctly
        process.stdout.write(data);
        onEvent({
            type: 'output',
            sessionId: state.id,
            timestamp: new Date(),
            data,
        });
        const next = adapter.detectStatus(data, state.status);
        if (next !== null) {
            state.transition(next);
        }
    });
    // ── Input: forward stdin → PTY ──────────────────────────────────────────────
    // Raw mode disables line buffering and lets control characters (Ctrl+C etc.)
    // pass through as data to the PTY rather than being handled by Node.
    const isTTY = process.stdin.isTTY ?? false;
    if (isTTY)
        process.stdin.setRawMode(true);
    process.stdin.resume();
    const onStdinData = (chunk) => {
        term.write(chunk.toString('binary'));
        // User responded — reset to running so the next question fires a notification
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
    // ── Cleanup helper ───────────────────────────────────────────────────────────
    function teardown() {
        process.stdin.removeListener('data', onStdinData);
        process.stdout.removeListener('resize', onResize);
        if (isTTY)
            process.stdin.setRawMode(false);
        process.stdin.pause();
    }
    return new Promise((resolve, reject) => {
        term.onExit(({ exitCode, signal }) => {
            teardown();
            if (signal && exitCode !== 0) {
                // Process was killed by a signal — surface as an error event
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
        // Catch spawn errors (e.g. command not found)
        process.nextTick(() => {
            // node-pty doesn't emit an 'error' event; spawn failures surface as
            // immediate exits with code 127 or throw synchronously — handled above.
        });
    });
}
//# sourceMappingURL=runSession.js.map
#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const runSession_1 = require("./runner/runSession");
const claudeAdapter_1 = require("./adapters/claudeAdapter");
const codexAdapter_1 = require("./adapters/codexAdapter");
const backendNotifier_1 = require("./notifications/backendNotifier");
const loadEnv_1 = require("./config/loadEnv");
const showSessionQr_1 = require("./qr/showSessionQr");
const backendClient_1 = require("./api/backendClient");
const crypto_1 = require("crypto"); // fallback when backend is unreachable
// ── ANSI helpers ─────────────────────────────────────────────────────────────
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
function timestamp() {
    return new Date().toISOString().split('T')[1].replace('Z', '');
}
// ── Event handler ─────────────────────────────────────────────────────────────
function makeEventHandler(sessionId, sessionName) {
    const tag = `${DIM}[ashral]${RESET}`;
    const label = sessionName ? `"${sessionName}"` : 'session';
    const notifier = new backendNotifier_1.BackendNotifier(sessionId);
    return function onEvent(event) {
        if (event.type === 'output')
            return;
        const ts = `${DIM}${timestamp()}${RESET}`;
        switch (event.type) {
            case 'status_changed': {
                process.stderr.write(`\n${tag} ${ts} ${CYAN}status${RESET}  ${event.from} → ${event.to}\n`);
                if (event.to === 'waiting_for_input') {
                    notifier.send({
                        title: label,
                        body: 'AI is waiting for your input.',
                        priority: 'high',
                        rawText: event.text,
                    });
                }
                else if (event.to === 'approval_required') {
                    notifier.send({
                        title: label,
                        body: 'AI is waiting for your approval.',
                        priority: 'urgent',
                        rawText: event.text,
                    });
                }
                else if (event.to === 'error') {
                    notifier.send({
                        title: label,
                        body: 'AI encountered an error.',
                        priority: 'high',
                        rawText: event.text,
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
                process.stderr.write(`\n${tag} ${ts} ${GREEN}done${RESET}     exit code ${event.exitCode}\n`);
                notifier.send({
                    title: label,
                    body: 'Session completed.',
                    priority: 'normal',
                });
                break;
        }
    };
}
// ── Shared run logic ──────────────────────────────────────────────────────────
async function runAgent(adapter, options, passthroughArgs) {
    let sessionId = (0, crypto_1.randomUUID)(); // fallback if backend is unreachable
    try {
        sessionId = await (0, backendClient_1.createSession)({ agent: adapter.agentName, name: options.name ?? adapter.agentName });
    }
    catch (err) {
        if (err instanceof backendClient_1.OutdatedClientError) {
            process.stderr.write(`\n${RED}[ashral] ${err.message}${RESET}\n\n`);
            process.exit(1);
        }
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[ashral] Warning: could not register session with backend: ${msg}\n`);
    }
    (0, showSessionQr_1.showSessionQr)(sessionId, options.name);
    try {
        await (0, runSession_1.runSession)({
            adapter,
            name: options.name,
            sessionId,
            passthroughArgs,
            onEvent: makeEventHandler(sessionId, options.name),
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[ashral] Fatal: ${message}\n`);
        process.exit(1);
    }
    finally {
        await (0, backendClient_1.deleteSession)(sessionId);
    }
}
// ── CLI definition ────────────────────────────────────────────────────────────
(0, loadEnv_1.loadEnvFile)();
const program = new commander_1.Command();
program
    .name('ashral')
    .description('Control center for AI coding agents')
    .version('0.1.0');
const runCmd = program.command('run').description('Run an AI coding agent');
runCmd
    .command('claude')
    .description('Start a Claude Code session')
    .option('--name <name>', 'human-readable session name')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (options, command) => {
    await runAgent(new claudeAdapter_1.ClaudeAdapter(), options, command.args);
});
runCmd
    .command('codex')
    .description('Start an OpenAI Codex session')
    .option('--name <name>', 'human-readable session name')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (options, command) => {
    await runAgent(new codexAdapter_1.CodexAdapter(), options, command.args);
});
// ── notify:test ───────────────────────────────────────────────────────────────
program
    .command('notify:test')
    .description('Send a test notification via backend')
    .argument('<sessionId>', 'session ID to notify')
    .action(async (sessionId) => {
    await (0, backendClient_1.notifySession)(sessionId, 'Ashral test', 'If you see this, notifications are working.', 'high');
    process.stderr.write('[ashral] Done.\n');
});
program.parse(process.argv);
//# sourceMappingURL=cli.js.map
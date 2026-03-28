#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const runSession_1 = require("./runner/runSession");
const claudeAdapter_1 = require("./adapters/claudeAdapter");
const ntfyNotifier_1 = require("./notifications/ntfyNotifier");
const firebaseNotifier_1 = require("./notifications/firebaseNotifier");
const multiNotifier_1 = require("./notifications/multiNotifier");
const loadEnv_1 = require("./config/loadEnv");
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
// ── Event handler factory ────────────────────────────────────────────────────
// Returns an onEvent callback. Logs to stderr and fires push notifications
// when Claude needs attention.
function makeEventHandler(sessionName, notifier) {
    const tag = `${DIM}[ashral]${RESET}`;
    const label = sessionName ? `"${sessionName}"` : 'session';
    return function onEvent(event) {
        // Raw output is already mirrored to stdout — skip it here
        if (event.type === 'output')
            return;
        const ts = `${DIM}${timestamp()}${RESET}`;
        switch (event.type) {
            case 'status_changed': {
                process.stderr.write(`\n${tag} ${ts} ${CYAN}status${RESET}  ${event.from} → ${event.to}\n`);
                if (!notifier) {
                    process.stderr.write(`${tag} ${ts} ${DIM}(no notifier configured)${RESET}\n`);
                    break;
                }
                // Notify when Claude needs the user's attention
                if (event.to === 'waiting_for_input') {
                    process.stderr.write(`${tag} ${ts} ${YELLOW}notify${RESET}  sending push notification...\n`);
                    notifier.send({
                        title: `Ashral - ${label}`,
                        body: 'Claude is waiting for your input.',
                        priority: 'high',
                    });
                }
                else if (event.to === 'approval_required') {
                    process.stderr.write(`${tag} ${ts} ${YELLOW}notify${RESET}  sending push notification...\n`);
                    notifier.send({
                        title: `Ashral - ${label} [approval]`,
                        body: 'Claude needs your approval before continuing.',
                        priority: 'urgent',
                    });
                }
                else if (event.to === 'error') {
                    process.stderr.write(`${tag} ${ts} ${YELLOW}notify${RESET}  sending push notification...\n`);
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
                process.stderr.write(`\n${tag} ${ts} ${GREEN}done${RESET}     exit code ${event.exitCode}\n`);
                break;
        }
    };
}
// ── Notifier setup ────────────────────────────────────────────────────────────
// Builds ALL configured notifiers and fans out to them in parallel via MultiNotifier.
// Firebase and ntfy are independent — both fire when both are configured.
//
// Config (set in ~/.ashral/.env):
//   ASHRAL_FIREBASE_SERVICE_ACCOUNT  path to service account JSON, or the JSON string itself
//   ASHRAL_FCM_TOKEN                 FCM device registration token
//   ASHRAL_NTFY_URL                  e.g. https://ntfy.sh/your-topic
function resolveNotifier(ntfyFlagUrl) {
    const active = [];
    const labels = [];
    // ── Firebase ──────────────────────────────────────────────────────────────
    const serviceAccount = process.env.ASHRAL_FIREBASE_SERVICE_ACCOUNT;
    const deviceToken = process.env.ASHRAL_FCM_TOKEN;
    if (serviceAccount && deviceToken) {
        try {
            active.push(new firebaseNotifier_1.FirebaseNotifier({ serviceAccount, deviceToken }));
            labels.push('Firebase');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[ashral] Firebase init failed: ${msg}\n`);
        }
    }
    else {
        if (!serviceAccount)
            process.stderr.write(`[ashral] ${DIM}ASHRAL_FIREBASE_SERVICE_ACCOUNT not set${RESET}\n`);
        if (!deviceToken)
            process.stderr.write(`[ashral] ${DIM}ASHRAL_FCM_TOKEN not set${RESET}\n`);
    }
    // ── ntfy ──────────────────────────────────────────────────────────────────
    const ntfyUrl = ntfyFlagUrl ?? process.env.ASHRAL_NTFY_URL;
    if (ntfyUrl) {
        active.push(new ntfyNotifier_1.NtfyNotifier(ntfyUrl));
        labels.push('ntfy');
    }
    else {
        process.stderr.write(`[ashral] ${DIM}ASHRAL_NTFY_URL not set${RESET}\n`);
    }
    if (active.length === 0)
        return { notifier: null, labels: [] };
    if (active.length === 1)
        return { notifier: active[0], labels };
    return { notifier: new multiNotifier_1.MultiNotifier(active), labels };
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
    .option('--notify-url <url>', 'ntfy.sh topic URL for push notifications (or set ASHRAL_NTFY_URL)')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (options, command) => {
    const passthroughArgs = command.args;
    const adapter = new claudeAdapter_1.ClaudeAdapter();
    const { notifier, labels } = resolveNotifier(options.notifyUrl);
    process.stderr.write('\n');
    if (options.name) {
        process.stderr.write(`[ashral] Starting session: ${options.name}\n`);
    }
    if (labels.length > 0) {
        process.stderr.write(`[ashral] Push notifications active: ${labels.join(' + ')}\n`);
    }
    else {
        process.stderr.write(`[ashral] Push notifications: none configured\n`);
    }
    process.stderr.write('\n');
    try {
        await (0, runSession_1.runSession)({
            adapter,
            name: options.name,
            passthroughArgs,
            onEvent: makeEventHandler(options.name, notifier),
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[ashral] Fatal: ${message}\n`);
        process.exit(1);
    }
});
// ── notify test ───────────────────────────────────────────────────────────────
program
    .command('notify:test')
    .description('Send a test notification to all configured providers')
    .action(async () => {
    const { notifier, labels } = resolveNotifier(undefined);
    if (!notifier) {
        process.stderr.write('[ashral] No notifiers configured. Check ~/.ashral/.env\n');
        process.exit(1);
    }
    process.stderr.write(`[ashral] Sending test notification via: ${labels.join(' + ')}\n`);
    await notifier.send({
        title: 'Ashral test',
        body: 'If you see this, notifications are working.',
        priority: 'high',
    });
    process.stderr.write('[ashral] Done.\n');
});
program.parse(process.argv);
//# sourceMappingURL=cli.js.map
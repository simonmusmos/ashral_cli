"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseAdapter = void 0;
const child_process_1 = require("child_process");
/**
 * BaseAdapter defines the contract every agent adapter must implement.
 *
 * Each adapter is responsible for two things:
 *  1. Knowing how to build the spawn command for its agent.
 *  2. Inspecting raw PTY output and mapping it to a session status.
 *
 * Keep all agent-specific knowledge inside its adapter. The runner stays generic.
 */
class BaseAdapter {
    constructor() {
        /**
         * Whether this adapter routes its AI API traffic through the local Anthropic
         * proxy. When true, the proxy captures clean text for storage. When false,
         * the runner saves output directly from the PTY.
         */
        this.usesAnthropicProxy = false;
        /**
         * Whether this adapter routes its AI API traffic through the local OpenAI
         * proxy. When true, the proxy captures clean text for storage.
         */
        this.usesOpenAIProxy = false;
    }
    /**
     * Checks whether the agent CLI is installed and on PATH.
     * Throws a descriptive error if not found.
     */
    verify() {
        const { command } = this.getCommand([]);
        const which = process.platform === 'win32' ? 'where' : 'which';
        try {
            (0, child_process_1.execSync)(`${which} ${command}`, { stdio: 'ignore' });
        }
        catch {
            throw new Error(`"${command}" is not installed or not on PATH.\n` +
                `Install it first, then re-run: ashral run ${this.agentName}`);
        }
    }
    /**
     * Scans accumulated startup PTY output for the agent's internal session ID.
     * Called on a growing buffer of early output until a match is found.
     * Returns null if the ID is not yet detectable in the given text.
     */
    extractAgentSessionId(_raw) {
        return null;
    }
}
exports.BaseAdapter = BaseAdapter;
//# sourceMappingURL=baseAdapter.js.map
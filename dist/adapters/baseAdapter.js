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
}
exports.BaseAdapter = BaseAdapter;
//# sourceMappingURL=baseAdapter.js.map
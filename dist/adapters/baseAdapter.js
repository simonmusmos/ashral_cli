"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseAdapter = void 0;
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
}
exports.BaseAdapter = BaseAdapter;
//# sourceMappingURL=baseAdapter.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionState = void 0;
const crypto_1 = require("crypto");
class SessionState {
    constructor(agent, name, cwd, emit, id) {
        this.emit = emit;
        this.session = {
            id: id ?? (0, crypto_1.randomUUID)(),
            name,
            agent,
            status: 'starting',
            startedAt: new Date(),
            cwd,
        };
    }
    get id() {
        return this.session.id;
    }
    get status() {
        return this.session.status;
    }
    /** Transition to a new status and emit a status_changed event. No-ops on same status. */
    transition(to) {
        const from = this.session.status;
        if (from === to)
            return;
        this.session.status = to;
        const event = {
            type: 'status_changed',
            sessionId: this.session.id,
            timestamp: new Date(),
            from,
            to,
        };
        this.emit(event);
    }
    /** Mark the session as done. Sets endedAt and transitions to completed. */
    complete(exitCode) {
        this.session.endedAt = new Date();
        this.transition('completed');
        this.emit({
            type: 'completed',
            sessionId: this.session.id,
            timestamp: new Date(),
            exitCode,
        });
    }
    snapshot() {
        return { ...this.session };
    }
}
exports.SessionState = SessionState;
//# sourceMappingURL=sessionState.js.map
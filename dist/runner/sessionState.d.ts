import type { Session, SessionStatus } from '../types/session';
import type { AshralEvent } from '../types/events';
export declare class SessionState {
    private session;
    private readonly emit;
    constructor(agent: string, name: string | undefined, cwd: string, emit: (event: AshralEvent) => void);
    get id(): string;
    get status(): SessionStatus;
    /** Transition to a new status and emit a status_changed event. No-ops on same status. */
    transition(to: SessionStatus): void;
    /** Mark the session as done. Sets endedAt and transitions to completed. */
    complete(exitCode: number): void;
    snapshot(): Readonly<Session>;
}
//# sourceMappingURL=sessionState.d.ts.map
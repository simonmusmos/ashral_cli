import type { BaseAdapter } from '../adapters/baseAdapter';
import type { AshralEvent } from '../types/events';
export interface RunSessionOptions {
    adapter: BaseAdapter;
    name?: string;
    /** Extra args forwarded verbatim to the agent CLI (everything after --) */
    passthroughArgs: string[];
    onEvent: (event: AshralEvent) => void;
}
/**
 * Spawns the agent inside a PTY, bridges all I/O, and drives the session
 * state machine. Resolves when the agent process exits.
 */
export declare function runSession(options: RunSessionOptions): Promise<void>;
//# sourceMappingURL=runSession.d.ts.map
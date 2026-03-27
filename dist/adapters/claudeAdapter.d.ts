import { BaseAdapter, type AdapterCommand } from './baseAdapter';
import type { SessionStatus } from '../types/session';
export declare class ClaudeAdapter extends BaseAdapter {
    readonly agentName = "claude";
    getCommand(passthroughArgs: string[]): AdapterCommand;
    detectStatus(raw: string, currentStatus: SessionStatus): SessionStatus | null;
    private matches;
}
//# sourceMappingURL=claudeAdapter.d.ts.map
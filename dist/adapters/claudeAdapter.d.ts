import { BaseAdapter, type AdapterCommand } from './baseAdapter';
import type { SessionStatus } from '../types/session';
export declare class ClaudeAdapter extends BaseAdapter {
    readonly agentName = "claude";
    readonly usesAnthropicProxy = true;
    getCommand(passthroughArgs: string[]): AdapterCommand;
    detectStatus(raw: string, currentStatus: SessionStatus): SessionStatus | null;
    extractAgentSessionId(raw: string): string | null;
    private matches;
}
//# sourceMappingURL=claudeAdapter.d.ts.map
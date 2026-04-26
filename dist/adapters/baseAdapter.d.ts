import type { SessionStatus } from '../types/session';
export interface AdapterCommand {
    /** The executable to spawn (must be on PATH or an absolute path) */
    command: string;
    /** Arguments passed directly to the executable */
    args: string[];
    /** Additional env vars merged into process.env for this session */
    env?: Record<string, string>;
}
/**
 * BaseAdapter defines the contract every agent adapter must implement.
 *
 * Each adapter is responsible for two things:
 *  1. Knowing how to build the spawn command for its agent.
 *  2. Inspecting raw PTY output and mapping it to a session status.
 *
 * Keep all agent-specific knowledge inside its adapter. The runner stays generic.
 */
export declare abstract class BaseAdapter {
    /** Human-readable agent identifier, e.g. "claude" */
    abstract readonly agentName: string;
    /**
     * Whether this adapter routes its AI API traffic through the local Anthropic
     * proxy. When true, the proxy captures clean text for storage. When false,
     * the runner saves output directly from the PTY.
     */
    readonly usesAnthropicProxy: boolean;
    /**
     * Whether this adapter routes its AI API traffic through the local OpenAI
     * proxy. When true, the proxy captures clean text for storage.
     */
    readonly usesOpenAIProxy: boolean;
    /**
     * Checks whether the agent CLI is installed and on PATH.
     * Throws a descriptive error if not found.
     */
    verify(): void;
    /**
     * Returns the command and args needed to start the agent.
     * @param passthroughArgs - extra args forwarded from the CLI (after --)
     */
    abstract getCommand(passthroughArgs: string[]): AdapterCommand;
    /**
     * Inspects a chunk of raw PTY output and returns a new status if a
     * transition should occur, or null to leave the status unchanged.
     *
     * This is called on every data chunk so keep it fast.
     */
    abstract detectStatus(output: string, currentStatus: SessionStatus): SessionStatus | null;
    /**
     * Scans accumulated startup PTY output for the agent's internal session ID.
     * Called on a growing buffer of early output until a match is found.
     * Returns null if the ID is not yet detectable in the given text.
     */
    extractAgentSessionId(_raw: string): string | null;
}
//# sourceMappingURL=baseAdapter.d.ts.map
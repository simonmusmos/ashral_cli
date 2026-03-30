import type { SessionStatus } from './session';

export type EventType =
  | 'output'
  | 'status_changed'
  | 'agent_prompt'
  | 'error'
  | 'completed';

interface BaseEvent {
  type: EventType;
  sessionId: string;
  timestamp: Date;
}

export interface OutputEvent extends BaseEvent {
  type: 'output';
  // Raw bytes from the PTY — may contain ANSI escape codes
  data: string;
}

export interface StatusChangedEvent extends BaseEvent {
  type: 'status_changed';
  from: SessionStatus;
  to: SessionStatus;
  /** Cleaned text from the output chunk that triggered this transition */
  text?: string;
}

// Fired when the adapter detects that the agent has issued a prompt to the user
export interface AgentPromptEvent extends BaseEvent {
  type: 'agent_prompt';
  prompt: string;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  message: string;
}

export interface CompletedEvent extends BaseEvent {
  type: 'completed';
  exitCode: number;
}

export type AshralEvent =
  | OutputEvent
  | StatusChangedEvent
  | AgentPromptEvent
  | ErrorEvent
  | CompletedEvent;

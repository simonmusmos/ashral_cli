export type SessionStatus =
  | 'starting'
  | 'running'
  | 'waiting_for_input'
  | 'approval_required'
  | 'error'
  | 'completed';

export interface Session {
  id: string;
  name?: string;
  agent: string;
  status: SessionStatus;
  startedAt: Date;
  endedAt?: Date;
  cwd: string;
}

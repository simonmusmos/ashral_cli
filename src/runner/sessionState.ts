import { randomUUID } from 'crypto';
import type { Session, SessionStatus } from '../types/session';
import type { AshralEvent, StatusChangedEvent } from '../types/events';

export class SessionState {
  private session: Session;
  private readonly emit: (event: AshralEvent) => void;

  constructor(
    agent: string,
    name: string | undefined,
    cwd: string,
    emit: (event: AshralEvent) => void,
    id?: string,
  ) {
    this.emit = emit;
    this.session = {
      id: id ?? randomUUID(),
      name,
      agent,
      status: 'starting',
      startedAt: new Date(),
      cwd,
    };
  }

  get id(): string {
    return this.session.id;
  }

  get status(): SessionStatus {
    return this.session.status;
  }

  /** Transition to a new status and emit a status_changed event. No-ops on same status. */
  transition(to: SessionStatus, text?: string): void {
    const from = this.session.status;
    if (from === to) return;

    this.session.status = to;

    const event: StatusChangedEvent = {
      type: 'status_changed',
      sessionId: this.session.id,
      timestamp: new Date(),
      from,
      to,
      ...(text !== undefined && { text }),
    };
    this.emit(event);
  }

  /** Mark the session as done. Sets endedAt and transitions to completed. */
  complete(exitCode: number): void {
    this.session.endedAt = new Date();
    this.transition('completed');
    this.emit({
      type: 'completed',
      sessionId: this.session.id,
      timestamp: new Date(),
      exitCode,
    });
  }

  snapshot(): Readonly<Session> {
    return { ...this.session };
  }
}

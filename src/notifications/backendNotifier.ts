import { notifySession } from '../api/backendClient';
import type { Notifier, NotificationPayload } from './notifier';

/**
 * Sends notifications via the Ashral backend.
 * The backend looks up all registered devices for the session and dispatches FCM.
 * The CLI no longer needs Firebase credentials.
 */
export class BackendNotifier implements Notifier {
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async send(payload: NotificationPayload): Promise<void> {
    await notifySession(
      this.sessionId,
      payload.title,
      payload.body,
      payload.priority ?? 'normal',
      payload.rawText,
    );
  }
}

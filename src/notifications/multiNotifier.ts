import type { Notifier, NotificationPayload } from './notifier';

/**
 * Fans out a single send() call to every configured notifier in parallel.
 * One failing notifier never blocks the others.
 */
export class MultiNotifier implements Notifier {
  private readonly notifiers: Notifier[];

  constructor(notifiers: Notifier[]) {
    this.notifiers = notifiers;
  }

  async send(payload: NotificationPayload): Promise<void> {
    await Promise.allSettled(this.notifiers.map((n) => n.send(payload)));
  }
}

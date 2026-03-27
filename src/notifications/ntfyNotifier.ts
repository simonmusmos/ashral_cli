import type { Notifier, NotificationPayload } from './notifier';

// ntfy.sh priority values: https://docs.ntfy.sh/publish/#message-priority
const PRIORITY_MAP: Record<NonNullable<NotificationPayload['priority']>, string> = {
  low: '2',
  normal: '3',
  high: '4',
  urgent: '5',
};

/**
 * Sends push notifications via ntfy.sh (or any self-hosted ntfy instance).
 *
 * Setup:
 *   1. Install the ntfy app on your phone (iOS / Android — free).
 *   2. Pick a topic name — something unguessable like "ashral-simon-7x3k".
 *   3. Subscribe to that topic in the app.
 *   4. Set ASHRAL_NTFY_URL=https://ntfy.sh/<your-topic>  (or pass it to the constructor).
 *
 * No account required for public topics on ntfy.sh.
 * For privacy, run a self-hosted ntfy instance and point the URL there.
 */
// HTTP headers must be Latin-1 (ISO-8859-1). Strip anything outside that range
// so unicode chars like em dashes don't cause a ByteString conversion error.
function toHeaderSafeAscii(str: string): string {
  return str.replace(/[^\x00-\xFF]/g, '').trim();
}

export class NtfyNotifier implements Notifier {
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async send(payload: NotificationPayload): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      'Title': toHeaderSafeAscii(payload.title),
      'Priority': PRIORITY_MAP[payload.priority ?? 'normal'],
    };

    if (payload.url) {
      headers['Actions'] = `view, Open, ${payload.url}`;
    }

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: payload.body,
      });

      if (!res.ok) {
        process.stderr.write(
          `[ashral] ntfy notification failed: HTTP ${res.status} ${res.statusText}\n`,
        );
      }
    } catch (err) {
      // Never let a notification failure crash the session
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashral] ntfy notification error: ${msg}\n`);
    }
  }
}

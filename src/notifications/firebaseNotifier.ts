import { initializeApp, getApps, cert, type ServiceAccount } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { Notifier, NotificationPayload } from './notifier';

// FCM Android priority values
const ANDROID_PRIORITY: Record<NonNullable<NotificationPayload['priority']>, 'normal' | 'high'> = {
  low: 'normal',
  normal: 'normal',
  high: 'high',
  urgent: 'high',
};

// APNs interrupt level for iOS
const APNS_INTERRUPT_LEVEL: Record<
  NonNullable<NotificationPayload['priority']>,
  'passive' | 'active' | 'time-sensitive' | 'critical'
> = {
  low: 'passive',
  normal: 'active',
  high: 'time-sensitive',
  urgent: 'time-sensitive',
};

export interface FirebaseNotifierConfig {
  /**
   * Path to a Firebase service account JSON file,
   * OR the JSON content as a string,
   * OR a parsed service account object.
   */
  serviceAccount: string | ServiceAccount;
  /** FCM device registration token for the target phone */
  deviceToken: string;
}

export class FirebaseNotifier implements Notifier {
  private readonly deviceToken: string;

  constructor(config: FirebaseNotifierConfig) {
    this.deviceToken = config.deviceToken;

    // Initialise the Admin SDK once — safe to call from multiple sessions
    if (getApps().length === 0) {
      const sa =
        typeof config.serviceAccount === 'string'
          ? this.parseServiceAccount(config.serviceAccount)
          : config.serviceAccount;

      initializeApp({ credential: cert(sa) });
    }
  }

  async send(payload: NotificationPayload): Promise<void> {
    const priority = payload.priority ?? 'normal';

    try {
      await getMessaging().send({
        token: this.deviceToken,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        android: {
          priority: ANDROID_PRIORITY[priority],
          notification: {
            sound: 'default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              interruptionLevel: APNS_INTERRUPT_LEVEL[priority],
            },
          },
        },
      });
    } catch (err) {
      // Never let a notification failure crash the session
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashral] Firebase notification error: ${msg}\n`);
    }
  }

  private parseServiceAccount(input: string): ServiceAccount {
    // Accept either a file path or raw JSON string
    if (input.trim().startsWith('{')) {
      return JSON.parse(input) as ServiceAccount;
    }

    // It's a file path — read synchronously (only at startup, not on each send)
    const { readFileSync } = require('fs') as typeof import('fs');
    const content = readFileSync(input, 'utf-8');
    return JSON.parse(content) as ServiceAccount;
  }
}

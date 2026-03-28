import { initializeApp, getApps, cert, type ServiceAccount } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { Notifier, NotificationPayload } from './notifier';

// FCM message-level delivery priority (wakes up the device)
const ANDROID_MESSAGE_PRIORITY: Record<NonNullable<NotificationPayload['priority']>, 'normal' | 'high'> = {
  low: 'normal',
  normal: 'high',
  high: 'high',
  urgent: 'high',
};

// Android notification display priority (controls heads-up / sound)
const ANDROID_NOTIFICATION_PRIORITY: Record<
  NonNullable<NotificationPayload['priority']>,
  'default' | 'high' | 'max'
> = {
  low: 'default',
  normal: 'high',
  high: 'high',
  urgent: 'max',
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
      const messageId = await getMessaging().send({
        token: this.deviceToken,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        android: {
          // High priority wakes the device even in Doze mode
          priority: ANDROID_MESSAGE_PRIORITY[priority],
          notification: {
            // No channelId — let FCM create the default channel automatically,
            // same as the Firebase Console test does.
            sound: 'default',
            priority: ANDROID_NOTIFICATION_PRIORITY[priority],
            defaultSound: true,
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
      process.stderr.write(`[ashral] Firebase sent OK — messageId: ${messageId}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ashral] Firebase error: ${msg}\n`);
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

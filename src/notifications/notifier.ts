export interface NotificationPayload {
  title: string;
  body: string;
  /** Optional urgency hint — providers map this to their own priority scale */
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** Optional deep-link or action URL */
  url?: string;
}

/**
 * Minimal interface every push provider must satisfy.
 * Implementations should be fire-and-forget (errors logged, never thrown).
 */
export interface Notifier {
  send(payload: NotificationPayload): Promise<void>;
}

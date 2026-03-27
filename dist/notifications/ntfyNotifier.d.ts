import type { Notifier, NotificationPayload } from './notifier';
export declare class NtfyNotifier implements Notifier {
    private readonly url;
    constructor(url: string);
    send(payload: NotificationPayload): Promise<void>;
}
//# sourceMappingURL=ntfyNotifier.d.ts.map
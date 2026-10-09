import { App } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import { DeliveryMessage, PermanentDeliveryError } from '../../domain/types';
import { ChannelProvider, SendResult } from '../../domain/provider-ports';

const DEAD_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

/** Firebase Cloud Messaging (Android, iOS via APNs bridge, web push). */
export class FcmPushProvider extends ChannelProvider {
  readonly name = 'fcm';
  readonly channel = 'push' as const;
  private readonly messaging: Messaging;

  constructor(app: App) {
    super();
    this.messaging = getMessaging(app);
  }

  async send(message: DeliveryMessage): Promise<SendResult> {
    const res = await this.messaging.sendEachForMulticast({
      tokens: message.to,
      notification: { title: message.title, body: message.body },
      data: {
        link: message.link,
        type: message.type,
        deliveryId: message.deliveryId,
      },
      android: {
        priority: message.priority === 'transactional' ? 'high' : 'normal',
        collapseKey: message.type,
      },
      apns: { headers: { 'apns-collapse-id': message.type.slice(0, 64) } },
    });
    const invalidTokens = res.responses.flatMap((r, i) =>
      !r.success && r.error && DEAD_TOKEN.has(r.error.code)
        ? [message.to[i]]
        : [],
    );
    if (res.successCount === 0) {
      if (invalidTokens.length === message.to.length)
        throw new PermanentDeliveryError('all push tokens dead', invalidTokens);
      throw new Error(
        `FCM: ${res.responses[0]?.error?.message ?? 'all sends failed'}`,
      );
    }
    const first = res.responses.find((r) => r.success)!;
    return {
      provider: this.name,
      providerMessageId: first.messageId!,
      invalidTokens,
    };
  }
}

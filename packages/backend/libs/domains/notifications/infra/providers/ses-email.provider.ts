import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PermanentDeliveryError, DeliveryMessage } from '../../domain/types';
import { ChannelProvider, SendResult } from '../../domain/provider-ports';

/**
 * Amazon SES (primary email). The configuration set publishes bounce /
 * complaint / delivery events to SNS → `POST /api/notifications/webhooks/ses`.
 */
export class SesEmailProvider extends ChannelProvider {
  readonly name = 'ses';
  readonly channel = 'email' as const;
  private readonly client: SESv2Client;

  constructor(
    private readonly from: string,
    region: string,
    private readonly configurationSet = 'marketplace-notifications',
  ) {
    super();
    this.client = new SESv2Client({ region });
  }

  async send(message: DeliveryMessage): Promise<SendResult> {
    try {
      const res = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: message.to },
          ConfigurationSetName: this.configurationSet,
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: message.html, Charset: 'UTF-8' },
                Text: { Data: message.body, Charset: 'UTF-8' },
              },
              Headers: unsubscribeHeaders(message).map(([Name, Value]) => ({
                Name,
                Value,
              })),
            },
          },
          EmailTags: [
            { Name: 'type', Value: message.type.replace(/[^\w-]/g, '_') },
          ],
        }),
      );
      return { provider: this.name, providerMessageId: res.MessageId! };
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'MessageRejected' || name === 'BadRequestException')
        throw new PermanentDeliveryError(
          `SES rejected: ${(error as Error).message}`,
        );
      throw error;
    }
  }
}

/** RFC 8058 one-click unsubscribe (Gmail/Yahoo bulk-sender requirement since 2024). */
export function unsubscribeHeaders(
  message: DeliveryMessage,
): [string, string][] {
  if (!message.unsubscribeUrl) return [];
  return [
    ['List-Unsubscribe', `<${message.unsubscribeUrl}>`],
    ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'],
  ];
}

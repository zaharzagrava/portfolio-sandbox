import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DeliveryMessage } from '../../domain/types';
import { ChannelProvider, SendResult } from '../../domain/provider-ports';

/** Local/test stand-ins when no Twilio / FCM credentials are configured. `sent` is inspectable in specs. */
abstract class LogProvider extends ChannelProvider {
  private readonly logger = new Logger(`LogProvider:${this.constructor.name}`);
  readonly sent: DeliveryMessage[] = [];

  async send(message: DeliveryMessage): Promise<SendResult> {
    this.sent.push(message);
    this.logger.log(
      `[${this.channel}] → ${message.to.join(', ')}: ${message.title}`,
    );
    return { provider: this.name, providerMessageId: randomUUID() };
  }
}

export class LogSmsProvider extends LogProvider {
  readonly name = 'log-sms';
  readonly channel = 'sms' as const;
}

export class LogPushProvider extends LogProvider {
  readonly name = 'log-push';
  readonly channel = 'push' as const;
}

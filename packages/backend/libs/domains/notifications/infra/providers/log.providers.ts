import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DeliveryMessage } from '../../domain/types';
import { ChannelProvider, SendResult } from '../../domain/provider-ports';

/**
 * Local/test stand-ins when no Twilio / FCM credentials are configured (never in production: the provider factories
 * refuse to start). A message handled here is recorded with `provider: "log"` and is never reported `delivered`: nothing
 * left the process and no provider will ever call back about it. `sent` is inspectable in specs.
 */
abstract class LogProvider extends ChannelProvider {
  readonly name = 'log';
  private readonly logger = new Logger(`LogProvider:${this.constructor.name}`);
  readonly sent: DeliveryMessage[] = [];

  send(message: DeliveryMessage): Promise<SendResult> {
    this.sent.push(message);
    this.logger.log(
      `[${this.channel}] → ${message.to.join(', ')}: ${message.title}`,
    );
    return Promise.resolve({
      provider: this.name,
      providerMessageId: randomUUID(),
    });
  }
}

export class LogSmsProvider extends LogProvider {
  readonly channel = 'sms' as const;
}

export class LogPushProvider extends LogProvider {
  readonly channel = 'push' as const;
}

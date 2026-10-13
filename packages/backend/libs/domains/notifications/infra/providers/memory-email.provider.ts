import { randomUUID } from 'node:crypto';
import { DeliveryMessage } from '../../domain/types';
import { ChannelProvider, SendResult } from '../../domain/provider-ports';
import { linksOf, memoryMailbox } from '../../domain/mailbox';

/** `EMAIL_PROVIDER=memory`: no network, the mail lands in `memoryMailbox`. Dev and test only. */
export class MemoryEmailProvider extends ChannelProvider {
  readonly name = 'memory';
  readonly channel = 'email' as const;

  send(message: DeliveryMessage): Promise<SendResult> {
    for (const to of message.to)
      memoryMailbox.add({
        to,
        subject: message.subject,
        text: message.body,
        links: linksOf(message.html, message.body, message.link),
      });
    return Promise.resolve({
      provider: this.name,
      providerMessageId: randomUUID(),
    });
  }
}

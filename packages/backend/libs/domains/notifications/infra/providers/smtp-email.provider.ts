import { createTransport, Transporter } from 'nodemailer';
import { DeliveryMessage, PermanentDeliveryError } from '../../domain/types';
import { ChannelProvider, SendResult } from '../../domain/provider-ports';
import { unsubscribeHeaders } from './ses-email.provider';

/** SMTP: failover provider in production, the only one locally (Mailpit catches everything at :8025). */
export class SmtpEmailProvider extends ChannelProvider {
  readonly name = 'smtp';
  readonly channel = 'email' as const;
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    super();
    // Pooled connections (reused across messages) via URL options: smtp://host:port?pool=true&maxConnections=5
    this.transport = createTransport(
      `${url}${url.includes('?') ? '&' : '?'}pool=true&maxConnections=5`,
    );
  }

  async send(message: DeliveryMessage): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.body,
        headers: Object.fromEntries(unsubscribeHeaders(message)),
      });
      return { provider: this.name, providerMessageId: info.messageId };
    } catch (error) {
      // 5xx SMTP reply = permanent (mailbox doesn't exist); 4xx / network = transient.
      const code = (error as { responseCode?: number }).responseCode;
      if (code && code >= 500 && code < 600)
        throw new PermanentDeliveryError(`SMTP ${code}`, message.to);
      throw error;
    }
  }
}

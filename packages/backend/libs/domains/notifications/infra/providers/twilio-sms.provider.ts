import { DeliveryMessage, PermanentDeliveryError } from '../../domain/types';
import { ChannelProvider, SendResult } from '../../domain/provider-ports';

/** Twilio error codes meaning "never send to this number again". */
const PERMANENT_CODES = new Set([21211, 21214, 21610, 21612, 21614]);

/** Twilio Messages REST API (no SDK: one form POST). Status callbacks → `/api/notifications/webhooks/twilio`. */
export class TwilioSmsProvider extends ChannelProvider {
  readonly name = 'twilio';
  readonly channel = 'sms' as const;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string,
    private readonly statusCallbackUrl: string,
  ) {
    super();
  }

  async send(message: DeliveryMessage): Promise<SendResult> {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: message.to[0],
          From: this.from,
          Body: `${message.title}: ${message.body}`.slice(0, 320),
          StatusCallback: this.statusCallbackUrl,
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      sid?: string;
      code?: number;
      message?: string;
    };
    if (res.ok && json.sid)
      return { provider: this.name, providerMessageId: json.sid };
    if (json.code && PERMANENT_CODES.has(json.code))
      throw new PermanentDeliveryError(
        `Twilio ${json.code}: ${json.message}`,
        message.to,
      );
    throw new Error(`Twilio ${res.status}: ${json.message ?? 'unknown'}`);
  }
}

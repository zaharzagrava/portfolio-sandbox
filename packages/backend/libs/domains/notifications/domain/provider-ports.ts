import { DeliveryMessage } from './types';

export interface SendResult {
  provider: string;
  providerMessageId: string;
  /** Push only: tokens the provider reported as unregistered. */
  invalidTokens?: string[];
}

/**
 * One port per channel; adapters are real SDKs (SES, SMTP, Twilio, FCM) plus
 * log-only fakes for local/test. Adapters throw `PermanentDeliveryError` for
 * "this address will never work" (no failover, suppress) and anything else for
 * transient failures (failover to the next provider, then SQS retry).
 */
export abstract class ChannelProvider {
  abstract readonly name: string;
  abstract readonly channel: DeliveryMessage['channel'];
  abstract send(message: DeliveryMessage): Promise<SendResult>;
}

export const EMAIL_PROVIDERS = Symbol('EMAIL_PROVIDERS');
export const SMS_PROVIDERS = Symbol('SMS_PROVIDERS');
export const PUSH_PROVIDERS = Symbol('PUSH_PROVIDERS');

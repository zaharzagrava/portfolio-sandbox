import { Injectable } from '@nestjs/common';
import { createHmac, createVerify } from 'node:crypto';

export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
}

const SIGNED_FIELDS: Record<SnsMessage['Type'], (keyof SnsMessage)[]> = {
  Notification: [
    'Message',
    'MessageId',
    'Subject',
    'Timestamp',
    'TopicArn',
    'Type',
  ],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const MAX_AGE_MS = 60 * 60_000;

/**
 * Verifies an SNS HTTP delivery (SES bounce/complaint events) the way the AWS
 * SDKs do: the signing cert must come from an SNS host over HTTPS (otherwise an
 * attacker points SigningCertURL at their own cert), the canonical string is
 * rebuilt from the documented fields, and old messages are rejected (replay).
 * The caller must ALSO pin the TopicArn: anyone can produce validly signed
 * messages from a topic in their own AWS account.
 */
@Injectable()
export class SnsVerifier {
  private readonly certs = new Map<string, Promise<string>>();

  async verify(message: SnsMessage, now = Date.now()): Promise<boolean> {
    const fields = SIGNED_FIELDS[message.Type];
    if (!fields || !message.Signature || !message.SigningCertURL) return false;
    let certUrl: URL;
    try {
      certUrl = new URL(message.SigningCertURL);
    } catch {
      return false;
    }
    if (certUrl.protocol !== 'https:' || !SNS_HOST.test(certUrl.hostname))
      return false;
    if (Math.abs(now - Date.parse(message.Timestamp)) > MAX_AGE_MS)
      return false;

    const canonical = fields
      .filter((f) => message[f] !== undefined)
      .map((f) => `${f}\n${message[f]}\n`)
      .join('');
    const pem = await this.certificate(certUrl.toString());
    return createVerify(
      message.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1',
    )
      .update(canonical, 'utf8')
      .verify(pem, message.Signature, 'base64');
  }

  /** Overridable in specs (a locally generated key pair stands in for AWS's cert). */
  fetchCertificate(url: string): Promise<string> {
    return fetch(url, { signal: AbortSignal.timeout(5_000) }).then((r) => {
      if (!r.ok) throw new Error(`cert fetch ${r.status}`);
      return r.text();
    });
  }

  private certificate(url: string): Promise<string> {
    let cert = this.certs.get(url);
    if (!cert) {
      cert = this.fetchCertificate(url).catch((e) => {
        this.certs.delete(url);
        throw e;
      });
      this.certs.set(url, cert);
    }
    return cert;
  }
}

/** Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted(k+v)...)). */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

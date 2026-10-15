import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  parseSignatureHeader,
  verifySignatureWith,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_TOLERANCE_SEC,
} from '@marketplace-sandbox/contracts';

export const SIGNATURE_HEADER = WEBHOOK_SIGNATURE_HEADER;

/**
 * `Marketplace-Signature: t=<unix>,v1=<hex hmac(secret, t + "." + body)>[,v1=<...>]`
 * (04/03 §5, Stripe scheme). The timestamp is INSIDE the MAC, so receivers can
 * reject replays older than 5 minutes; one `v1` per active secret, so a
 * receiver mid-rotation accepts either.
 *
 * The instant is always passed in (epoch milliseconds from the injected clock): this file never reads the wall clock
 * (constitution I.3), so the boundary of a rotation overlap is testable to the millisecond.
 */
export function signWebhook(
  body: string,
  secrets: string[],
  now: number,
): string {
  const t = Math.floor(now / 1000);
  return [
    `t=${t}`,
    ...secrets.map(
      (s) =>
        `v1=${createHmac('sha256', s).update(`${t}.${body}`).digest('hex')}`,
    ),
  ].join(',');
}

export interface WebhookSecrets {
  /** The current secret, always active. */
  current: string;
  /** The previous secret, active only before `previousExpiresAt`. */
  previous?: string | null;
  previousExpiresAt?: Date | string | null;
}

/**
 * The secrets that sign a request at `now` (epoch ms): the current one first, the previous one only while
 * `now < previousExpiresAt` (excluded exactly at the expiry instant, FR-013). Chosen at signing time at every attempt,
 * so a retry after the expiry never carries the first attempt's set.
 */
export function activeSecrets(secrets: WebhookSecrets, now: number): string[] {
  const out = [secrets.current];
  if (secrets.previous && secrets.previousExpiresAt) {
    const expires = new Date(secrets.previousExpiresAt).getTime();
    if (Number.isFinite(expires) && now < expires) out.push(secrets.previous);
  }
  return out;
}

const hmacHex = (secret: string, message: string): string =>
  createHmac('sha256', secret).update(message).digest('hex');

const equalHex = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Receiver-side reference verifier (FR-016, AS-17; published in the developer docs and used by our own specs): strict
 * parse (a duplicate `t`, a malformed pair or an odd-length or non-hex `v1` is false), any `v1` may match, constant-time
 * comparison, tolerance 300 s both ways, never throws.
 */
export function verifyWebhook(
  body: string,
  header: string | undefined,
  secret: string,
  {
    toleranceSec = WEBHOOK_SIGNATURE_TOLERANCE_SEC,
    now,
  }: { toleranceSec?: number; now: number },
): boolean {
  return verifySignatureWith(hmacHex, equalHex, {
    body,
    header,
    secret,
    nowMs: now,
    toleranceSec,
  });
}

export { parseSignatureHeader };

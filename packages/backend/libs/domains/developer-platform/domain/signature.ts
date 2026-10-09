import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'Marketplace-Signature';
const DEFAULT_TOLERANCE_SEC = 300;

/**
 * `Marketplace-Signature: t=<unix>,v1=<hex hmac(secret, t + "." + body)>[,v1=<...>]`
 * (04/03 §5, Stripe scheme). The timestamp is INSIDE the MAC, so receivers can
 * reject replays older than 5 minutes; one `v1` per active secret, so a
 * receiver mid-rotation accepts either.
 */
export function signWebhook(
  body: string,
  secrets: string[],
  now = Date.now(),
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

/** Receiver-side helper (published in the SDK docs; also used by our own specs). */
export function verifyWebhook(
  body: string,
  header: string | undefined,
  secret: string,
  { toleranceSec = DEFAULT_TOLERANCE_SEC, now = Date.now() } = {},
): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec)
    return false;
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'),
  );
  return parts.some(
    ([k, v]) =>
      k === 'v1' &&
      v?.length === expected.length &&
      timingSafeEqual(Buffer.from(v), expected),
  );
}

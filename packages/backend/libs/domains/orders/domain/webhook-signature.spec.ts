import { createHmac } from 'node:crypto';
import {
  InvalidSignatureError,
  verifyStripeSignature,
} from './webhook-signature';

const SECRET = 'whsec_current_secret_value';
const PREVIOUS = 'whsec_previous_secret_value';
const NOW = new Date('2026-10-10T12:00:00.000Z');
const nowSec = Math.floor(NOW.getTime() / 1000);
const body = Buffer.from('{"id":"evt_1","type":"payment_intent.succeeded"}');

const sig = (secret: string, ts: number, raw: Buffer = body) =>
  createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
const header = (secret: string, ts: number, raw?: Buffer) =>
  `t=${ts},v1=${sig(secret, ts, raw)}`;

const verify = (h: string | undefined, secrets = [SECRET], raw = body) =>
  verifyStripeSignature(raw, h, secrets, NOW);

describe('S10 AS-53: Stripe signature check', () => {
  it('S10 AS-53: a correct signature passes', () => {
    expect(() => verify(header(SECRET, nowSec))).not.toThrow();
  });

  it.each<[string, string | undefined]>([
    ['missing header', undefined],
    ['empty header', ''],
    ['no v1 part', `t=${nowSec}`],
    ['no timestamp', `v1=${sig(SECRET, nowSec)}`],
    ['non-numeric timestamp', `t=abc,v1=${sig(SECRET, nowSec)}`],
    ['non-hex signature', `t=${nowSec},v1=zzzz`],
    ['wrong signature', `t=${nowSec},v1=${'0'.repeat(64)}`],
    ['signature of another secret', header('whsec_other', nowSec)],
    ['signature of other body', header(SECRET, nowSec, Buffer.from('{}'))],
    [
      'truncated signature',
      `t=${nowSec},v1=${sig(SECRET, nowSec).slice(0, 20)}`,
    ],
  ])('S10 AS-53: %s is refused with a typed error', (_n, h) => {
    expect(() => verify(h)).toThrow(InvalidSignatureError);
  });

  it.each([
    ['exactly 300 s old', nowSec - 300, true],
    ['301 s old', nowSec - 301, false],
    ['exactly 300 s in the future', nowSec + 300, true],
    ['301 s in the future', nowSec + 301, false],
  ])('S10 AS-53: timestamp %s → accepted=%s', (_n, ts, ok) => {
    const run = () => verify(header(SECRET, ts));
    if (ok) expect(run).not.toThrow();
    else expect(run).toThrow(InvalidSignatureError);
  });

  it('S10 AS-53: the previous secret is accepted during rotation, another is not', () => {
    expect(() =>
      verify(header(PREVIOUS, nowSec), [SECRET, PREVIOUS]),
    ).not.toThrow();
    expect(() => verify(header(PREVIOUS, nowSec), [SECRET])).toThrow(
      InvalidSignatureError,
    );
  });

  it('S10 AS-53: several v1 entries — any matching one passes', () => {
    const h = `t=${nowSec},v1=${'1'.repeat(64)},v1=${sig(SECRET, nowSec)}`;
    expect(() => verify(h)).not.toThrow();
  });

  it('S10 AS-53: no secrets configured refuses everything', () => {
    expect(() => verify(header(SECRET, nowSec), [])).toThrow(
      InvalidSignatureError,
    );
  });
});

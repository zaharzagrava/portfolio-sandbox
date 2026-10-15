import { createHmac } from 'node:crypto';
import {
  activeSecrets,
  signWebhook,
  verifyWebhook,
  WebhookSecrets,
} from './signature';

/** Signer (platform) and verifier (receiver SDK) must agree byte for byte. */
describe('webhook signatures', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'order.paid' });
  const now = Date.UTC(2026, 9, 1, 12);

  it('verifies with the current secret, and with either secret during rotation', () => {
    const header = signWebhook(body, ['whsec_new', 'whsec_old'], now);
    expect(verifyWebhook(body, header, 'whsec_new', { now })).toBe(true);
    expect(verifyWebhook(body, header, 'whsec_old', { now })).toBe(true);
    expect(verifyWebhook(body, header, 'whsec_other', { now })).toBe(false);
  });

  it('rejects tampered bodies and replays outside the tolerance window', () => {
    const header = signWebhook(body, ['s'], now);
    expect(verifyWebhook(`${body} `, header, 's', { now })).toBe(false);
    expect(verifyWebhook(body, header, 's', { now: now + 301_000 })).toBe(
      false,
    );
    expect(
      verifyWebhook(
        body,
        header.replace(/t=\d+/, `t=${Math.floor(now / 1000) + 1}`),
        's',
        { now },
      ),
    ).toBe(false);
  });

  describe('signing (AS-16)', () => {
    it('S43 AS-16: the header is t=<unix seconds>,v1=<hex HMAC-SHA256 over "<t>.<body>">', () => {
      const header = signWebhook(body, ['whsec_a'], now);
      const t = Math.floor(now / 1000);
      const hex = createHmac('sha256', 'whsec_a')
        .update(`${t}.${body}`)
        .digest('hex');
      expect(header).toBe(`t=${t},v1=${hex}`);
    });

    it('S43 AS-16: the same bytes verify; another secret or one changed byte do not', () => {
      const header = signWebhook(body, ['whsec_a'], now);
      expect(verifyWebhook(body, header, 'whsec_a', { now })).toBe(true);
      expect(verifyWebhook(body, header, 'whsec_b', { now })).toBe(false);
      const changed = body.replace('order.paid', 'order.paiD');
      expect(changed).not.toBe(body);
      expect(verifyWebhook(changed, header, 'whsec_a', { now })).toBe(false);
    });

    it('S43 AS-16: the timestamp is in the MAC: another t with the same hex fails', () => {
      const header = signWebhook(body, ['whsec_a'], now);
      const t = Math.floor(now / 1000);
      const forged = header.replace(`t=${t}`, `t=${t + 1}`);
      expect(verifyWebhook(body, forged, 'whsec_a', { now })).toBe(false);
    });

    it('S43 AS-16: two secrets give two v1 values, current first', () => {
      const header = signWebhook(body, ['whsec_new', 'whsec_old'], now);
      const values = header.split(',').filter((p) => p.startsWith('v1='));
      expect(values).toHaveLength(2);
      const t = Math.floor(now / 1000);
      expect(values[0]).toBe(
        `v1=${createHmac('sha256', 'whsec_new').update(`${t}.${body}`).digest('hex')}`,
      );
    });

    it('S43 AS-16: the clock is injected: the same instant always gives the same header', () => {
      expect(signWebhook(body, ['s'], now)).toBe(signWebhook(body, ['s'], now));
      expect(signWebhook(body, ['s'], now + 1000)).not.toBe(
        signWebhook(body, ['s'], now),
      );
    });
  });

  describe('verifier table (AS-17)', () => {
    const secret = 'whsec_verify';
    const t = Math.floor(now / 1000);
    const valid = signWebhook(body, [secret], now);
    const hex = valid.split('v1=')[1];

    it.each<[string, string | undefined, number, boolean]>([
      ['a valid header', valid, now, true],
      ['t exactly 300 s old', valid, now + 300_000, true],
      ['t 301 s old', valid, now + 301_000, false],
      ['t exactly 300 s in the future', valid, now - 300_000, true],
      ['t 301 s in the future', valid, now - 301_000, false],
      ['an absent header', undefined, now, false],
      ['an empty header', '', now, false],
      ['a header without t', `v1=${hex}`, now, false],
      ['a header without v1', `t=${t}`, now, false],
      ['a non-numeric t', `t=abc,v1=${hex}`, now, false],
      ['a fractional t', `t=${t}.5,v1=${hex}`, now, false],
      ['an odd-length v1', `t=${t},v1=${hex.slice(0, -1)}`, now, false],
      ['a non-hex v1', `t=${t},v1=${'zz'.repeat(32)}`, now, false],
      ['an empty v1', `t=${t},v1=`, now, false],
      ['a pair without =', `t=${t},v1`, now, false],
      ['garbage', 'hello world', now, false],
      ['duplicate t pairs', `t=${t},t=${t},v1=${hex}`, now, false],
      [
        'duplicate t pairs with different values',
        `t=${t},t=${t + 1},v1=${hex}`,
        now,
        false,
      ],
      [
        'one wrong then one right v1',
        `t=${t},v1=${'0'.repeat(64)},v1=${hex}`,
        now,
        true,
      ],
      [
        'one right then one wrong v1',
        `t=${t},v1=${hex},v1=${'0'.repeat(64)}`,
        now,
        true,
      ],
      [
        'unknown extra pairs are ignored',
        `t=${t},v2=abcd,v1=${hex}`,
        now,
        true,
      ],
      ['upper-case hex', `t=${t},v1=${hex.toUpperCase()}`, now, true],
      ['spaces around pairs', `t=${t}, v1=${hex}`, now, true],
    ])('S43 AS-17: %s -> %s', (_name, header, at, expected) => {
      expect(verifyWebhook(body, header, secret, { now: at })).toBe(expected);
    });

    it('S43 AS-17: many v1 values (50) are accepted when any matches, and never throw', () => {
      const wrong = Array.from(
        { length: 49 },
        (_, i) => `v1=${String(i).padStart(2, '0').repeat(32)}`,
      );
      const header = `t=${t},${wrong.join(',')},v1=${hex}`;
      expect(verifyWebhook(body, header, secret, { now })).toBe(true);
      expect(verifyWebhook(body, header, 'other', { now })).toBe(false);
    });

    it('S43 AS-17: a wrong secret and a changed body are false', () => {
      expect(verifyWebhook(body, valid, 'nope', { now })).toBe(false);
      expect(verifyWebhook(`${body}x`, valid, secret, { now })).toBe(false);
    });

    it('S43 AS-17: the tolerance is a parameter', () => {
      expect(
        verifyWebhook(body, valid, secret, {
          now: now + 60_000,
          toleranceSec: 59,
        }),
      ).toBe(false);
      expect(
        verifyWebhook(body, valid, secret, {
          now: now + 60_000,
          toleranceSec: 60,
        }),
      ).toBe(true);
    });

    it('S43 AS-17: hostile inputs never throw', () => {
      for (const header of [
        null,
        undefined,
        42,
        {},
        't=,v1=,',
        ',,,',
        '=',
        't==1',
      ])
        expect(() =>
          verifyWebhook(body, header as never, secret, { now }),
        ).not.toThrow();
    });
  });

  describe('active secret selection (AS-19)', () => {
    const t0 = Date.UTC(2026, 9, 1, 12);
    const expires = t0 + 24 * 3_600_000;
    const secrets: WebhookSecrets = {
      current: 'whsec_new',
      previous: 'whsec_old',
      previousExpiresAt: new Date(expires),
    };

    it.each<[string, number, string[]]>([
      ['at rotation time', t0, ['whsec_new', 'whsec_old']],
      ['at expiry - 1 ms', expires - 1, ['whsec_new', 'whsec_old']],
      ['exactly at expiry', expires, ['whsec_new']],
      ['after expiry', expires + 1, ['whsec_new']],
    ])('S43 AS-19: %s -> %j', (_name, at, expected) => {
      expect(activeSecrets(secrets, at)).toEqual(expected);
    });

    it('S43 AS-19: the header has two v1 values at expiry - 1 ms and one at expiry', () => {
      const count = (at: number) =>
        signWebhook(body, activeSecrets(secrets, at), at)
          .split(',')
          .filter((p) => p.startsWith('v1=')).length;
      expect(count(expires - 1)).toBe(2);
      expect(count(expires)).toBe(1);
    });

    it("S43 AS-19: a retry after expiry is signed with the set active then, not with the first attempt's", () => {
      const first = signWebhook(
        body,
        activeSecrets(secrets, t0 + 1000),
        t0 + 1000,
      );
      const retry = signWebhook(
        body,
        activeSecrets(secrets, expires + 5000),
        expires + 5000,
      );
      expect(first.split('v1=').length - 1).toBe(2);
      expect(retry.split('v1=').length - 1).toBe(1);
      // the old secret no longer verifies the retry
      expect(
        verifyWebhook(body, retry, 'whsec_old', { now: expires + 5000 }),
      ).toBe(false);
      expect(
        verifyWebhook(body, retry, 'whsec_new', { now: expires + 5000 }),
      ).toBe(true);
    });

    it('S43 AS-19: no previous secret, or a previous secret without an expiry, gives only the current one', () => {
      expect(activeSecrets({ current: 'c' }, t0)).toEqual(['c']);
      expect(activeSecrets({ current: 'c', previous: 'p' }, t0)).toEqual(['c']);
      expect(
        activeSecrets(
          { current: 'c', previousExpiresAt: new Date(expires) },
          t0,
        ),
      ).toEqual(['c']);
    });

    it('S43 AS-19: the expiry may be a Date or an ISO string', () => {
      expect(
        activeSecrets(
          {
            current: 'c',
            previous: 'p',
            previousExpiresAt: new Date(expires).toISOString(),
          },
          expires - 1,
        ),
      ).toEqual(['c', 'p']);
    });
  });
});

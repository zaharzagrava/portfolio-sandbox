import {
  MAX_SIGNATURE_AGE_SECONDS,
  signRevalidation,
  verifyRevalidation,
} from './revalidation-signature';
import { createHmac } from 'node:crypto';

const SECRET = 'revalidate-secret-of-sufficient-length';
const BODY = JSON.stringify({ tags: ['story:1', 'shop:2'], eventId: 'e-1' });
const NOW = 1_760_000_000;

describe('S27 revalidation signature', () => {
  it('S27 AS-51: the signature is the hex HMAC-SHA256 of "<timestamp>.<raw body>"', () => {
    const expected = createHmac('sha256', SECRET)
      .update(`${NOW}.${BODY}`)
      .digest('hex');
    expect(signRevalidation(SECRET, NOW, BODY)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('S27 AS-51: a receiver that recomputes the signature gets a match', () => {
    const signature = signRevalidation(SECRET, NOW, BODY);
    expect(verifyRevalidation(SECRET, String(NOW), BODY, signature, NOW)).toBe(
      true,
    );
    expect(
      verifyRevalidation(SECRET, String(NOW), BODY, signature, NOW + 299),
    ).toBe(true);
  });

  it('S27 AS-51: a changed body does not verify', () => {
    const signature = signRevalidation(SECRET, NOW, BODY);
    expect(
      verifyRevalidation(
        SECRET,
        String(NOW),
        BODY.replace('story:1', 'story:9'),
        signature,
        NOW,
      ),
    ).toBe(false);
  });

  it('S27 AS-51: a changed timestamp does not verify', () => {
    const signature = signRevalidation(SECRET, NOW, BODY);
    expect(
      verifyRevalidation(SECRET, String(NOW + 1), BODY, signature, NOW + 1),
    ).toBe(false);
  });

  it('S27 AS-51: another secret does not verify', () => {
    const signature = signRevalidation(
      'another-secret-another-secret-123',
      NOW,
      BODY,
    );
    expect(verifyRevalidation(SECRET, String(NOW), BODY, signature, NOW)).toBe(
      false,
    );
  });

  it('S27 AS-51: a timestamp older than 5 minutes is refused even when the signature is right', () => {
    expect(MAX_SIGNATURE_AGE_SECONDS).toBe(300);
    const signature = signRevalidation(SECRET, NOW, BODY);
    expect(
      verifyRevalidation(SECRET, String(NOW), BODY, signature, NOW + 301),
    ).toBe(false);
  });

  it('S27 AS-51: garbage never verifies and never throws', () => {
    expect(verifyRevalidation(SECRET, String(NOW), BODY, 'zz', NOW)).toBe(
      false,
    );
    expect(verifyRevalidation(SECRET, 'abc', BODY, 'ab', NOW)).toBe(false);
    expect(verifyRevalidation(SECRET, String(NOW), BODY, '', NOW)).toBe(false);
  });
});

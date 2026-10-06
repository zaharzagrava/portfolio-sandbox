import { signWebhook, verifyWebhook } from './signature';

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
    expect(verifyWebhook(body, header, 's', { now: now + 301_000 })).toBe(false);
    expect(verifyWebhook(body, header.replace(/t=\d+/, `t=${Math.floor(now / 1000) + 1}`), 's', { now })).toBe(false);
  });
});

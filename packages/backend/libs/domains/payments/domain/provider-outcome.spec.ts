import {
  classifyCharge,
  classifyLookup,
  type IntentSnapshot,
  type ProviderResponse,
} from './provider-outcome';

const expected = { amountMinor: 12_50, currency: 'EUR', orderId: 'order-1' };

const intent = (over: Partial<IntentSnapshot> = {}): ProviderResponse => ({
  kind: 'intent',
  intent: {
    id: 'pi_1',
    status: 'succeeded',
    amountMinor: 12_50,
    currency: 'eur',
    orderId: 'order-1',
    clientSecret: null,
    lastErrorCode: null,
    lastDeclineCode: null,
    ...over,
  },
});

describe('S13 AS-22: classification of provider answers (charge)', () => {
  it('succeeded intent -> succeeded with the provider reference', () => {
    expect(classifyCharge(intent(), expected)).toEqual({
      kind: 'succeeded',
      providerRef: 'pi_1',
    });
  });

  it.each([
    [
      { code: 'card_declined', declineCode: 'generic_decline' },
      'card_declined',
    ],
    [
      { code: 'card_declined', declineCode: 'insufficient_funds' },
      'insufficient_funds',
    ],
    [{ code: 'insufficient_funds' }, 'insufficient_funds'],
    [{ code: 'expired_card' }, 'expired_card'],
    [{ code: 'incorrect_cvc' }, 'declined_other'],
    [{}, 'declined_other'],
  ])('card error %p -> declined(%s)', (error, code) => {
    expect(classifyCharge({ kind: 'card_error', ...error }, expected)).toEqual({
      kind: 'declined',
      code,
    });
  });

  it('requires action keeps the intent and the client secret', () => {
    expect(
      classifyCharge(
        intent({ status: 'requires_action', clientSecret: 'cs_secret' }),
        expected,
      ),
    ).toEqual({
      kind: 'requires_action',
      providerRef: 'pi_1',
      clientSecret: 'cs_secret',
    });
  });

  it('requires action without a client secret is an invalid answer', () => {
    expect(
      classifyCharge(intent({ status: 'requires_action' }), expected),
    ).toEqual({ kind: 'invalid', field: 'clientSecret' });
  });

  it.each([400, 401, 403, 404, 422])('http %i -> rejected', (httpStatus) => {
    expect(
      classifyCharge(
        { kind: 'http_error', httpStatus, requestId: 'req_1' },
        expected,
      ),
    ).toEqual({ kind: 'rejected', httpStatus, requestId: 'req_1' });
  });

  it('429 and an open breaker -> not sent', () => {
    expect(
      classifyCharge({ kind: 'http_error', httpStatus: 429 }, expected),
    ).toEqual({ kind: 'not_sent', reason: 'rate_limited' });
    expect(
      classifyCharge({ kind: 'not_sent', reason: 'circuit_open' }, expected),
    ).toEqual({ kind: 'not_sent', reason: 'circuit_open' });
  });

  it.each([500, 502, 503])('http %i -> ambiguous', (httpStatus) => {
    expect(
      classifyCharge({ kind: 'http_error', httpStatus }, expected),
    ).toEqual({
      kind: 'ambiguous',
      reason: 'server_error',
    });
  });

  it.each(['timeout', 'network', 'malformed'] as const)(
    '%s -> ambiguous',
    (reason) => {
      expect(classifyCharge({ kind: 'ambiguous', reason }, expected)).toEqual({
        kind: 'ambiguous',
        reason,
      });
    },
  );

  it.each([
    ['amount', { amountMinor: 999 }],
    ['currency', { currency: 'usd' }],
    ['status', { status: undefined }],
    ['orderId', { orderId: 'someone-else' }],
  ])('a wrong %s makes the answer invalid', (field, over) => {
    expect(
      classifyCharge(intent(over as Partial<IntentSnapshot>), expected),
    ).toEqual({
      kind: 'invalid',
      field,
    });
  });

  it('a processing intent is ambiguous (the result comes later)', () => {
    expect(classifyCharge(intent({ status: 'processing' }), expected)).toEqual({
      kind: 'ambiguous',
      reason: 'processing',
    });
  });
});

describe('S13 AS-24..AS-28: classification of lookup answers', () => {
  it('succeeded / requires action / canceled / needs payment method', () => {
    expect(classifyLookup(intent(), expected)).toEqual({
      kind: 'succeeded',
      providerRef: 'pi_1',
    });
    expect(
      classifyLookup(
        intent({ status: 'requires_action', clientSecret: 'cs' }),
        expected,
      ),
    ).toEqual({
      kind: 'requires_action',
      providerRef: 'pi_1',
      clientSecret: 'cs',
    });
    expect(classifyLookup(intent({ status: 'canceled' }), expected)).toEqual({
      kind: 'failed',
      code: 'provider_canceled',
    });
    expect(
      classifyLookup(
        intent({
          status: 'requires_payment_method',
          lastErrorCode: 'card_declined',
        }),
        expected,
      ),
    ).toEqual({ kind: 'failed', code: 'card_declined' });
    expect(
      classifyLookup(intent({ status: 'requires_payment_method' }), expected),
    ).toEqual({ kind: 'failed', code: 'declined_other' });
  });

  it('nothing found, unreachable and mismatching answers', () => {
    expect(classifyLookup({ kind: 'not_found' }, expected)).toEqual({
      kind: 'not_found',
    });
    expect(
      classifyLookup({ kind: 'ambiguous', reason: 'timeout' }, expected),
    ).toEqual({ kind: 'unreachable' });
    expect(
      classifyLookup({ kind: 'not_sent', reason: 'circuit_open' }, expected),
    ).toEqual({ kind: 'unreachable' });
    expect(
      classifyLookup({ kind: 'http_error', httpStatus: 503 }, expected),
    ).toEqual({ kind: 'unreachable' });
    expect(classifyLookup(intent({ amountMinor: 1 }), expected)).toEqual({
      kind: 'mismatch',
      field: 'amount',
    });
    expect(classifyLookup(intent({ status: 'processing' }), expected)).toEqual({
      kind: 'pending',
    });
  });
});

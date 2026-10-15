import {
  createdWebhookEndpointSchema,
  createWebhookEndpointRequestSchema,
  parseSignatureHeader,
  rotateWebhookSecretRequestSchema,
  updateWebhookEndpointRequestSchema,
  verifySignatureWith,
  WEBHOOK_ERROR_CODES,
  WEBHOOK_EVENT_TYPES,
  webhookAttemptsQuerySchema,
  webhookEndpointListQuerySchema,
  webhookEndpointPageSchema,
  webhookMessageSchema,
  webhookOrderEventSchemas,
  webhookPayoutEventSchemas,
  webhookShopDeletedSchema,
} from './webhooks.ts';

const ok = (r: { success: boolean }) => r.success;
const created = '2026-10-06T12:00:00.000Z';

describe('S43 webhook contracts (parse tests)', () => {
  it('S43 AS-14: the catalogue is exactly the 11 types', () => {
    expect([...WEBHOOK_EVENT_TYPES]).toEqual([
      'order.paid',
      'order.cancelled',
      'order.refunded',
      'product.created',
      'product.updated',
      'product.archived',
      'product.deleted',
      'product.stock_low',
      'payout.paid',
      'payout.failed',
      'webhook.ping',
    ]);
  });

  describe('create request (AS-01, AS-02)', () => {
    const valid = { url: 'https://hooks.acme.test/in', events: ['order.paid', 'product.stock_low'] };
    it('S43 AS-02: a valid body parses, apiVersion is optional', () => {
      expect(ok(createWebhookEndpointRequestSchema.safeParse(valid))).toBe(true);
      expect(ok(createWebhookEndpointRequestSchema.safeParse({ ...valid, apiVersion: '2026-01-15' }))).toBe(true);
      expect(ok(createWebhookEndpointRequestSchema.safeParse({ ...valid, apiVersion: 'latest' }))).toBe(true);
    });

    it.each<[string, unknown]>([
      ['no url', { events: ['order.paid'] }],
      ['url not a string', { url: 5, events: ['order.paid'] }],
      ['url over 2,048 characters', { url: 'https://h.test/' + 'a'.repeat(2048), events: ['order.paid'] }],
      ['events missing', { url: 'https://h.test/' }],
      ['events empty', { url: 'https://h.test/', events: [] }],
      ['an unknown event type', { url: 'https://h.test/', events: ['order.exploded'] }],
      ['duplicate event types', { url: 'https://h.test/', events: ['order.paid', 'order.paid'] }],
      ['more than 20 event types', { url: 'https://h.test/', events: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
      ['an apiVersion that is not a date', { url: 'https://h.test/', events: ['order.paid'], apiVersion: 'v1' }],
      ['an unknown property', { url: 'https://h.test/', events: ['order.paid'], foo: 1 }],
      ['an enabled flag (moved to POST enable/disable)', { url: 'https://h.test/', events: ['order.paid'], enabled: false }],
    ])('S43 AS-02: %s is refused', (_name, body) => {
      expect(ok(createWebhookEndpointRequestSchema.safeParse(body))).toBe(false);
    });

    it('S43 AS-02: 20 distinct types are accepted (the limit is inclusive)', () => {
      expect(ok(createWebhookEndpointRequestSchema.safeParse({ url: 'https://h.test/', events: [...WEBHOOK_EVENT_TYPES] }))).toBe(true);
    });
  });

  describe('update request (AS-07)', () => {
    it('S43 AS-07: any subset of url, events, apiVersion parses', () => {
      expect(ok(updateWebhookEndpointRequestSchema.safeParse({ url: 'https://h.test/' }))).toBe(true);
      expect(ok(updateWebhookEndpointRequestSchema.safeParse({ events: ['order.paid'], apiVersion: '2026-10-01' }))).toBe(true);
    });
    it.each<[string, unknown]>([
      ['an empty body', {}],
      ['an enabled flag', { enabled: true }],
      ['an unknown property', { url: 'https://h.test/', secret: 'x' }],
      ['empty events', { events: [] }],
    ])('S43 AS-07: %s is refused', (_name, body) => {
      expect(ok(updateWebhookEndpointRequestSchema.safeParse(body))).toBe(false);
    });
  });

  describe('rotate request (AS-21)', () => {
    it.each([1, 24, 72])('S43 AS-21: overlapHours %i parses', (overlapHours) => {
      expect(ok(rotateWebhookSecretRequestSchema.safeParse({ overlapHours }))).toBe(true);
    });
    it('S43 AS-21: no body parses (default 24 h)', () => {
      expect(ok(rotateWebhookSecretRequestSchema.safeParse({}))).toBe(true);
    });
    it.each<[string, unknown]>([
      ['0', { overlapHours: 0 }],
      ['73', { overlapHours: 73 }],
      ['a non-integer', { overlapHours: 1.5 }],
      ['a string', { overlapHours: '24' }],
      ['an unknown property', { overlapHours: 24, force: true }],
    ])('S43 AS-21: overlapHours %s is refused', (_name, body) => {
      expect(ok(rotateWebhookSecretRequestSchema.safeParse(body))).toBe(false);
    });
  });

  describe('queries (AS-05, AS-60)', () => {
    it('S43 AS-05: the default limit is 25, 1 and 100 are accepted', () => {
      expect(webhookEndpointListQuerySchema.parse({}).limit).toBe(25);
      expect(webhookEndpointListQuerySchema.parse({ limit: '1' }).limit).toBe(1);
      expect(webhookEndpointListQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    });
    it.each(['0', '101', '-1', 'abc', '2.5'])('S43 AS-05: limit %s is refused', (limit) => {
      expect(ok(webhookEndpointListQuerySchema.safeParse({ limit }))).toBe(false);
    });
    it('S43 AS-60: attempts filters are eventId and ok=true|false', () => {
      expect(ok(webhookAttemptsQuerySchema.safeParse({ eventId: 'evt_1', ok: 'false', limit: '25' }))).toBe(true);
      expect(ok(webhookAttemptsQuerySchema.safeParse({ ok: 'maybe' }))).toBe(false);
      expect(ok(webhookAttemptsQuerySchema.safeParse({ other: 1 }))).toBe(false);
    });
  });

  describe('responses (AS-01, AS-05)', () => {
    it('S43 AS-01: a created endpoint shows a whsec_ secret of 43 base64url characters', () => {
      const base = { id: 'e1', url: 'https://h.test/', events: ['order.paid'], apiVersion: 'latest', status: 'enabled', createdAt: created };
      expect(ok(createdWebhookEndpointSchema.safeParse({ ...base, secret: 'whsec_' + 'A'.repeat(43) }))).toBe(true);
      expect(ok(createdWebhookEndpointSchema.safeParse({ ...base, secret: 'whsec_' + 'A'.repeat(42) }))).toBe(false);
      expect(ok(createdWebhookEndpointSchema.safeParse({ ...base, secret: 'whsec_' + 'A'.repeat(44) }))).toBe(false);
    });

    it('S43 AS-05: a list page has items and nextCursor; its items carry no secret field', () => {
      const item = {
        id: 'e1', url: 'https://h.test/', events: ['order.paid'], apiVersion: '2026-01-15', status: 'enabled',
        disabledReason: null, failingSince: null, breaker: 'closed', hasPreviousSecret: false,
        previousSecretExpiresAt: null, createdAt: created, updatedAt: created,
      };
      const parsed = webhookEndpointPageSchema.parse({ items: [{ ...item, secret: 'whsec_leak', secretSealed: 'x' }], nextCursor: null });
      expect(Object.keys(parsed.items[0])).not.toContain('secret');
      expect(Object.keys(parsed.items[0])).not.toContain('secretSealed');
      expect(ok(webhookEndpointPageSchema.safeParse({ items: [], nextCursor: 'abc' }))).toBe(true);
    });
  });

  it('S43 AS-69: the problem codes are the stable list of FR-050', () => {
    expect([...WEBHOOK_ERROR_CODES]).toEqual(
      expect.arrayContaining([
        'validation_failed', 'invalid_cursor', 'permission_denied', 'webhook_endpoint_not_found',
        'webhook_event_not_found', 'duplicate_endpoint_url', 'endpoint_state_conflict', 'rotation_in_progress',
        'no_previous_secret', 'endpoint_disabled', 'idempotency_in_flight', 'endpoint_url_rejected',
        'endpoint_limit_reached', 'idempotency_key_required', 'idempotency_key_reuse', 'rate_limited', 'service_unavailable',
      ]),
    );
    expect(WEBHOOK_ERROR_CODES).toHaveLength(17);
  });

  it('S43 AS-23: the outbound message has the documented shape and a deterministic-looking id', () => {
    const message = {
      id: 'evt_' + 'a'.repeat(32), object: 'event', type: 'order.paid', created, api_version: '2026-10-01',
      resource_version: 3, data: { object: { id: 'o1' } },
    };
    expect(ok(webhookMessageSchema.safeParse(message))).toBe(true);
    expect(ok(webhookMessageSchema.safeParse({ ...message, resource_version: null }))).toBe(true);
    expect(ok(webhookMessageSchema.safeParse({ ...message, id: 'evt_short' }))).toBe(false);
    expect(ok(webhookMessageSchema.safeParse({ ...message, type: 'order.exploded' }))).toBe(false);
  });

  describe('consumed events (AS-26, AS-29, AS-31, AS-66)', () => {
    const order = { orderId: '0196a000-0000-7000-8000-00000000000a', userId: 'u', orderVersion: 2 };
    it('S43 AS-26: order.cancelled and order.refunded accept shopIds (optional until S10 ships it)', () => {
      expect(ok(webhookOrderEventSchemas['order.cancelled'].safeParse({ ...order, reason: 'payment_failed', previousStatus: 'RESERVED', shopIds: ['s1'] }))).toBe(true);
      expect(ok(webhookOrderEventSchemas['order.cancelled'].safeParse({ ...order, reason: 'payment_failed', previousStatus: 'RESERVED' }))).toBe(true);
      expect(ok(webhookOrderEventSchemas['order.refunded'].safeParse({ ...order, amountMinor: 1, currency: 'EUR', reason: 'r', shopIds: ['s1'] }))).toBe(true);
      expect(ok(webhookOrderEventSchemas['order.cancelled'].safeParse({ ...order, reason: 'payment_failed', previousStatus: 'RESERVED', shopIds: [] }))).toBe(false);
    });
    it('S43 AS-31: an order.paid without shopOrders is invalid', () => {
      expect(ok(webhookOrderEventSchemas['order.paid'].safeParse({ ...order, totalMinor: 1, currency: 'EUR', paymentRef: 'p', paidAt: created, lines: [] }))).toBe(false);
    });
    it('S43 AS-29: payout events need the version and tolerate additions', () => {
      const payout = { payoutId: 'p1', shopId: 's1', periodStart: '2026-09-01', amountMinor: 10, currency: 'EUR', payoutVersion: 1, extra: true };
      expect(ok(webhookPayoutEventSchemas['payout.paid'].safeParse({ ...payout, transferRef: 't', paidAt: created }))).toBe(true);
      expect(ok(webhookPayoutEventSchemas['payout.failed'].safeParse({ ...payout, failureCode: 'x' }))).toBe(true);
      const { payoutVersion: _v, ...noVersion } = payout;
      expect(ok(webhookPayoutEventSchemas['payout.paid'].safeParse(noVersion))).toBe(false);
    });
    it('S43 AS-66: tenancy.shop_deleted needs shopId', () => {
      expect(ok(webhookShopDeletedSchema.safeParse({ shopId: 's1', shopVersion: 4 }))).toBe(true);
      expect(ok(webhookShopDeletedSchema.safeParse({}))).toBe(false);
    });
  });

  describe('reference verifier rules (AS-17)', () => {
    it('S43 AS-17: the strict parser accepts t and one or more v1, and nothing else', () => {
      expect(parseSignatureHeader('t=1790856000,v1=abcd,v1=EF01')).toEqual({ t: 1790856000, v1: ['abcd', 'ef01'] });
      for (const bad of [undefined, null, '', 'v1=abcd', 't=1', 't=1,t=2,v1=ab', 't=x,v1=ab', 't=1,v1=abc', 't=1,v1=zz', 't=1,v1', '=,'])
        expect(parseSignatureHeader(bad as never)).toBeNull();
    });
    it('S43 AS-17: the injected HMAC is compared, tolerance 300 s inclusive, and a throwing HMAC is false', () => {
      const hmac = (secret: string, message: string) => `${secret}|${message}`.length.toString(16).padStart(2, '0');
      const eq = (a: string, b: string) => a === b;
      const body = '{}';
      const t = 1_790_856_000;
      const header = `t=${t},v1=${hmac('s', `${t}.${body}`)}`;
      const input = { body, header, secret: 's', nowMs: t * 1000 };
      expect(verifySignatureWith(hmac, eq, input)).toBe(true);
      expect(verifySignatureWith(hmac, eq, { ...input, nowMs: (t + 300) * 1000 })).toBe(true);
      expect(verifySignatureWith(hmac, eq, { ...input, nowMs: (t + 301) * 1000 })).toBe(false);
      expect(verifySignatureWith(() => { throw new Error('boom'); }, eq, input)).toBe(false);
    });
  });
});

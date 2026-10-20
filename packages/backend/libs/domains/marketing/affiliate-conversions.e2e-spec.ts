import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import {
  linkConversionPageSchema,
  linkConversionReversedEventSchema,
  linkConvertedEventSchema,
  linkStatsSchema,
} from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { AffiliateConversionProjector } from './infra/affiliate-conversion.projector';
import {
  createShareLinksApp,
  type ShareLinksTestApp,
} from './testing/share-links.fixtures';

type TestUser = Awaited<ReturnType<ShareLinksTestApp['user']>>;

describe('J05 affiliate conversions: order.paid / order.refunded become credit on the link, once', () => {
  let t: ShareLinksTestApp;
  let owner: TestUser;
  let projector: AffiliateConversionProjector;

  beforeAll(async () => {
    t = await createShareLinksApp();
    projector = t.app.get(AffiliateConversionProjector);
    owner = await t.user();
  });
  afterAll(() => t.close());

  const envelope = (
    type: 'order.paid' | 'order.refunded',
    orderId: string,
    orderVersion: number,
    payload: Record<string, unknown>,
  ) => ({
    eventId: uuidv7(),
    type,
    version: 1,
    aggregateType: 'orders',
    aggregateId: orderId,
    aggregateVersion: orderVersion,
    occurredAt: new Date().toISOString(),
    payload: {
      orderId,
      userId: 'buyer-secret-id',
      orderVersion,
      currency: 'EUR',
      ...payload,
    },
  });
  const paid = (
    orderId: string,
    code: string | null,
    over: { totalMinor?: number; paidAt?: string; orderVersion?: number } = {},
  ) =>
    envelope('order.paid', orderId, over.orderVersion ?? 3, {
      totalMinor: over.totalMinor ?? 2_500,
      paymentRef: 'pi_x',
      paidAt: over.paidAt ?? '2026-10-19T10:00:00.000Z',
      lines: [],
      shopOrders: [],
      attribution: code ? { code, ownerId: owner.id } : null,
    });
  const refund = (
    orderId: string,
    code: string | null,
    amountMinor: number,
    orderVersion: number,
  ) =>
    envelope('order.refunded', orderId, orderVersion, {
      amountMinor,
      reason: 'requested',
      attribution: code ? { code, ownerId: owner.id } : null,
    });
  const feed = (...events: ReturnType<typeof envelope>[]) =>
    projector.project(events as never);
  const conversions = async (code: string, query = '') => {
    const res = await t.as(owner).get(`/api/links/${code}/conversions${query}`);
    expect(res.status).toBe(200);
    return linkConversionPageSchema.parse(res.body);
  };
  const stats = async (code: string) => {
    const res = await t.as(owner).get(`/api/links/${code}/stats`);
    expect(res.status).toBe(200);
    return linkStatsSchema.parse(res.body);
  };
  const linkEvents = async (code: string) =>
    (await outboxRowsFor(t.app, code)).filter((r) => r.kind === 'event');

  it('J05 AS-13: a paid order with attribution makes one CONFIRMED conversion and one link.converted, with no buyer and no order id anywhere', async () => {
    const code = await t.newLink(owner);
    const orderId = randomUUID();
    await feed(paid(orderId, code));

    const page = await conversions(code);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      status: 'CONFIRMED',
      amountMinor: 2_500,
      currency: 'EUR',
      refundedMinor: 0,
      paidAt: '2026-10-19T10:00:00.000Z',
    });
    const events = await linkEvents(code);
    expect(events.map((e) => e.type)).toEqual(['link.converted']);
    expect(events[0].topic).toBe('links.events');
    const body = (events[0].payload as { payload: unknown }).payload;
    expect(linkConvertedEventSchema.parse(body)).toMatchObject({
      linkCode: code,
      amountMinor: 2_500,
    });
    const s = await stats(code);
    expect(s.conversions).toBe(1);
    expect(s.convertedMinor).toBe(2_500);

    // no buyer, no order id, anywhere a client or the tap can read
    const everything = JSON.stringify([page, s, events.map((e) => e.payload)]);
    expect(everything).not.toContain(orderId);
    expect(everything).not.toContain('buyer-secret-id');
  });

  it('J05 AS-15: a redelivery, a replay and a later version of the same paid order change nothing', async () => {
    const code = await t.newLink(owner);
    const orderId = randomUUID();
    const event = paid(orderId, code);
    await feed(event);
    await feed(event);
    await feed(paid(orderId, code, { orderVersion: 4 }));
    expect((await conversions(code)).items).toHaveLength(1);
    expect((await linkEvents(code)).map((e) => e.type)).toEqual([
      'link.converted',
    ]);
    expect((await stats(code)).conversions).toBe(1);
  });

  it('J05 AS-16: a paid order without attribution leaves no conversion', async () => {
    const code = await t.newLink(owner);
    await feed(paid(randomUUID(), null));
    expect((await conversions(code)).items).toHaveLength(0);
    expect((await stats(code)).conversions).toBe(0);
    expect(await linkEvents(code)).toHaveLength(0);
  });

  it('J05 AS-19: a partial refund lowers the credited value; the full refund reverses the conversion once; a replayed or older refund changes nothing', async () => {
    const code = await t.newLink(owner);
    const orderId = randomUUID();
    await feed(paid(orderId, code, { totalMinor: 3_000 }));

    await feed(refund(orderId, code, 1_000, 5));
    let page = await conversions(code);
    expect(page.items[0]).toMatchObject({
      status: 'CONFIRMED',
      refundedMinor: 1_000,
    });
    expect((await stats(code)).convertedMinor).toBe(2_000);

    await feed(refund(orderId, code, 1_000, 5)); // replay
    await feed(refund(orderId, code, 1_000, 4)); // older
    expect((await conversions(code)).items[0].refundedMinor).toBe(1_000);

    await feed(refund(orderId, code, 2_000, 6));
    page = await conversions(code);
    expect(page.items[0]).toMatchObject({
      status: 'REVERSED',
      refundedMinor: 3_000,
    });
    const s = await stats(code);
    expect(s.conversions).toBe(0);
    expect(s.convertedMinor).toBe(0);

    await feed(refund(orderId, code, 2_000, 7)); // after reversal
    const events = await linkEvents(code);
    expect(events.map((e) => e.type)).toEqual([
      'link.converted',
      'link.conversion_reversed',
    ]);
    expect(
      linkConversionReversedEventSchema.parse(
        (events[1].payload as { payload: unknown }).payload,
      ),
    ).toMatchObject({ refundedMinor: 3_000, amountMinor: 3_000 });
  });

  it('J05 AS-19: a refund that arrives before its payment is kept and merged when the payment comes (both events, in order)', async () => {
    const code = await t.newLink(owner);
    const orderId = randomUUID();
    await feed(refund(orderId, code, 2_500, 6));
    expect((await conversions(code)).items).toHaveLength(0);
    expect(await linkEvents(code)).toHaveLength(0);

    await feed(paid(orderId, code, { totalMinor: 2_500 }));
    const page = await conversions(code);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      status: 'REVERSED',
      refundedMinor: 2_500,
      amountMinor: 2_500,
    });
    expect((await linkEvents(code)).map((e) => e.type)).toEqual([
      'link.converted',
      'link.conversion_reversed',
    ]);
  });

  it('J05 AS-13: only the owner reads the conversions of a link (404 for anyone else); pages are keyed and complete', async () => {
    const code = await t.newLink(owner);
    for (let i = 0; i < 3; i++)
      await feed(
        paid(randomUUID(), code, {
          paidAt: `2026-10-19T10:0${i}:00.000Z`,
          totalMinor: 1_000 + i,
        }),
      );
    const stranger = await t.user();
    expect(
      (await t.as(stranger).get(`/api/links/${code}/conversions`)).status,
    ).toBe(404);
    expect((await t.as(stranger).get(`/api/links/${code}/stats`)).status).toBe(
      404,
    );

    const first = await conversions(code, '?limit=2');
    expect(first.items.map((i) => i.amountMinor)).toEqual([1_002, 1_001]);
    expect(first.nextCursor).not.toBeNull();
    const second = await conversions(
      code,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.items.map((i) => i.amountMinor)).toEqual([1_000]);
    expect(second.nextCursor).toBeNull();

    const forged = await t
      .as(owner)
      .get(`/api/links/${code}/conversions?cursor=abc.def`);
    expect(forged.status).toBe(400);
  });
});

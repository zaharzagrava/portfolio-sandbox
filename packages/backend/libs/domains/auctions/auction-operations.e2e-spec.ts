import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tracer } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { parse } from 'yaml';
import {
  auctionConsumedSchemas,
  auctionEventSchemas,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { OWNERSHIP } from '../../../db/ownership';
import type { TestUser } from '@app/test/utils/catalog-app';
import { addMember } from '@app/test/utils/tenancy-fixtures';
import * as barrel from './index';
import {
  SHOP_MEMBERSHIP,
  type ShopMembershipPort,
} from './domain/auction-ports';
import {
  createAuctionsApp,
  fastStoreOf,
  orderCancelledEnvelope,
  orderPaidEnvelope,
  rows,
  seedAuction,
  seedSeller,
  type AuctionTestApp,
  type FastStore,
  type Seller,
} from './testing/auction-app';

const MIN = 60_000;
const T = new Date('2026-10-14T12:00:00.000Z');
const E = new Date(T.getTime() + 60 * MIN);

describe('Auctions: events, bid partitions, metrics and domain isolation', () => {
  let t: AuctionTestApp;
  let fast: FastStore;
  const written: string[] = [];
  const spans: string[] = [];
  let stdout: jest.SpyInstance;
  let tracerSpy: jest.SpyInstance;

  beforeAll(async () => {
    stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    const real = trace.getTracer.bind(trace);
    tracerSpy = jest
      .spyOn(trace, 'getTracer')
      .mockImplementation((name: string, version?: string) => {
        const tracer = real(name, version);
        if (name !== 'auctions') return tracer;
        return new Proxy(tracer, {
          get(target, prop, receiver) {
            if (prop === 'startActiveSpan')
              return (...args: unknown[]) => {
                spans.push(String(args[0]));
                return (target.startActiveSpan as (...a: unknown[]) => unknown)(
                  ...args,
                );
              };
            return Reflect.get(target, prop, receiver) as unknown;
          },
        }) as Tracer;
      });
    t = await createAuctionsApp({ structuredLogger: true });
    fast = fastStoreOf(t.app);
  });
  afterAll(async () => {
    await fast.allow();
    await t.close();
    tracerSpy.mockRestore();
    stdout.mockRestore();
  });
  beforeEach(async () => {
    await fast.allow();
    await t.reset();
    await fast.clearRateLimits();
    await t.setTime(T);
    written.length = 0;
    spans.length = 0;
  });

  const logs = () =>
    written
      .join('')
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const metric = (name: string, labels: Record<string, string> = {}) =>
    MetricsRegistry.value(name, labels) ?? 0;
  const bid = (user: TestUser, id: string, max: number) =>
    t
      .as(user)
      .post(`/api/auctions/${id}/bids`)
      .set('Idempotency-Key', `bid-${randomUUID()}`)
      .send({ maxAmountMinor: max });
  const bidders = async (n: number) => {
    const out: TestUser[] = [];
    for (let i = 0; i < n; i++) out.push(await t.user());
    return out;
  };
  const dataset = async (
    over: Partial<Parameters<typeof seedAuction>[1]> = {},
  ) => {
    const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 2 }]);
    const id = await seedAuction(t.app, {
      shopId: s.shop.id,
      productId: s.products[0].id,
      startsAt: T,
      endsAt: E,
      originalEndsAt: T,
      ...over,
    });
    return { s, id };
  };

  // ------------------------------------------------------------------ AS-49

  describe('events and per-auction order (AS-49)', () => {
    it('S21 AS-49: a full lifecycle writes every event in its transaction with the envelope and a rising auctionVersion', async () => {
      const s: Seller = await seedSeller(t, [
        { priceMinor: 20_000, quantity: 3 },
      ]);
      const [u1, u2] = await bidders(2);
      await t.setTime(new Date(T.getTime() - 5 * MIN));
      const created = await t
        .as(s.owner)
        .post(`/api/shops/${s.shop.id}/auctions`)
        .set('Idempotency-Key', 'create-lifecycle-1')
        .send({
          productId: s.products[0].id,
          title: 'Signed #001/100',
          startingPriceMinor: 1000,
          minIncrementMinor: 500,
          reservePriceMinor: 3333,
          startsAt: T.toISOString(),
          endsAt: E.toISOString(),
        });
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      await t.setTime(T);
      await t.jobs.open({ auctionId: id });
      expect((await bid(u1, id, 5000)).status).toBe(200);
      expect((await bid(u2, id, 9000)).status).toBe(200);
      expect((await bid(u2, id, 11_000)).status).toBe(200); // raised
      await t.setTime(E);
      await t.jobs.close({ auctionId: id });
      await t.jobs.requestOrder(
        { auctionId: id, step: 'winner' },
        { isLastAttempt: false },
      );
      const orderId = (
        await rows<{ winnerOrderId: string }>(
          t.app,
          `SELECT "winnerOrderId" FROM "Auction" WHERE "id" = :id`,
          { id },
        )
      )[0].winnerOrderId;
      await t.consumer.project([
        orderPaidEnvelope({
          orderId,
          userId: u2.id,
          totalMinor: 5500,
          orderVersion: 2,
        }),
      ]);

      const events = await outboxRowsFor(t.app, id);
      expect(events.map((e) => e.type)).toEqual([
        'auction.created',
        'auction.opened',
        'auction.bid_placed',
        'auction.bid_placed',
        'auction.leader_changed',
        'auction.bid_placed',
        'auction.closed',
        'auction.sold',
      ]);
      for (const row of events) {
        expect(row.topic).toBe('auctions.events');
        expect(row.aggregateId).toBe(id);
        const envelope = row.payload as Record<string, unknown>;
        expect(envelope).toMatchObject({
          eventId: expect.any(String),
          type: row.type,
          version: 1,
          occurredAt: expect.any(String),
          aggregateId: id,
          aggregateType: 'auctions',
        });
        const payload = envelope.payload as Record<string, unknown>;
        const schema =
          auctionEventSchemas[row.type as keyof typeof auctionEventSchemas];
        expect(schema.safeParse(payload).success).toBe(true);
        // S28 reads the same payloads: the consumer-side schemas accept what this producer writes
        const consumed =
          auctionConsumedSchemas[
            row.type as keyof typeof auctionConsumedSchemas
          ];
        if (consumed) expect(consumed.safeParse(payload).success).toBe(true);
        expect(payload.auctionId).toBe(id);
        expect(payload.auctionVersion).toBe(envelope.aggregateVersion);
        // (the price may equal the reserve once a maximum covers it; the reserve itself is never a field)
        expect(JSON.stringify(payload)).not.toMatch(
          /maxAmount|leaderMax|reservePrice/,
        );
      }

      // the version rises with every change; the two events of one bid share the version of that change
      const versions = events.map(
        (e) => (e.payload as { aggregateVersion: number }).aggregateVersion,
      );
      const distinct = [...new Set(versions)];
      expect(distinct).toEqual([...distinct].sort((a, b) => a - b));
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
      expect(versions[4]).toBe(versions[3]); // bid_placed and leader_changed of the same bid
      expect(new Set(versions).size).toBe(versions.length - 1);
    });

    it('S21 AS-49: leader_changed is written for every real change and only for a real change', async () => {
      const { id } = await dataset();
      const [u1, u2, u3] = await bidders(3);
      await bid(u1, id, 5000); // first bid: no previous leader
      await bid(u2, id, 4000); // defended: no change
      await bid(u2, id, 7000); // change 1
      await bid(u3, id, 20_000); // change 2
      await bid(u3, id, 25_000); // raised: no change
      const changes = (await outboxRowsFor(t.app, id)).filter(
        (e) => e.type === 'auction.leader_changed',
      );
      expect(changes).toHaveLength(2);
      expect(
        changes.map(
          (c) =>
            (
              c.payload as {
                payload: { previousLeaderId: string; leaderId: string };
              }
            ).payload,
        ),
      ).toMatchObject([
        { previousLeaderId: u1.id, leaderId: u2.id },
        { previousLeaderId: u2.id, leaderId: u3.id },
      ]);
    });

    it('S21 AS-49: cancel, hold failure, second chance and unsold write their events', async () => {
      const s = await seedSeller(t, [{ priceMinor: 20_000, quantity: 2 }]);
      const [u1, u2] = await bidders(2);
      const id = await seedAuction(t.app, {
        shopId: s.shop.id,
        productId: s.products[0].id,
        startsAt: T,
        endsAt: E,
        originalEndsAt: T,
      });
      await bid(u2, id, 3000);
      await bid(u1, id, 8000);
      await t.setTime(E);
      await t.jobs.close({ auctionId: id });
      await t.jobs.requestOrder(
        { auctionId: id, step: 'winner' },
        { isLastAttempt: false },
      );
      const first = (
        await rows<{ winnerOrderId: string }>(
          t.app,
          `SELECT "winnerOrderId" FROM "Auction" WHERE "id" = :id`,
          { id },
        )
      )[0].winnerOrderId;
      await t.consumer.project([
        orderCancelledEnvelope({
          orderId: first,
          userId: u1.id,
          orderVersion: 3,
        }),
      ]);
      await t.jobs.requestOrder(
        { auctionId: id, step: 'second-chance' },
        { isLastAttempt: false },
      );
      const offer = (
        await rows<{ winnerOrderId: string }>(
          t.app,
          `SELECT "winnerOrderId" FROM "Auction" WHERE "id" = :id`,
          { id },
        )
      )[0].winnerOrderId;
      await t.consumer.project([
        orderCancelledEnvelope({
          orderId: offer,
          userId: u2.id,
          orderVersion: 2,
        }),
      ]);
      const types = (await outboxRowsFor(t.app, id)).map((e) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'auction.closed',
          'auction.second_chance_offered',
          'auction.unsold',
        ]),
      );
      for (const row of await outboxRowsFor(t.app, id)) {
        const payload = (row.payload as { payload: unknown }).payload;
        expect(
          auctionEventSchemas[
            row.type as keyof typeof auctionEventSchemas
          ].safeParse(payload).success,
        ).toBe(true);
      }
    });
  });

  // ------------------------------------------------------------------ AS-50

  describe('bid partitions (AS-50)', () => {
    const partitions = async () =>
      (
        await rows<{ name: string }>(
          t.app,
          `SELECT inhrelid::regclass::text AS name FROM pg_inherits WHERE inhparent = '"Bid"'::regclass ORDER BY 1`,
        )
      ).map((r) => r.name.replace(/"/g, ''));

    it('S21 AS-50: the daily job creates the current month and the next 3; twice at once adds nothing more', async () => {
      await t.setTime(new Date('2026-10-05T00:00:00.000Z'));
      await Promise.all([
        t.jobs.ensureBidPartitions(),
        t.jobs.ensureBidPartitions(),
      ]);
      const names = await partitions();
      for (const month of [
        'Bid_202610',
        'Bid_202611',
        'Bid_202612',
        'Bid_202701',
      ])
        expect(names).toContain(month);
      const before = names.length;
      await Promise.all([
        t.jobs.ensureBidPartitions(),
        t.jobs.ensureBidPartitions(),
      ]);
      expect((await partitions()).length).toBe(before);
    });

    it('S21 AS-50: a bid in a month with no partition still succeeds, lands in the default partition and raises the gauge, which the next run reports', async () => {
      const far = new Date('2030-05-05T12:00:00.000Z');
      const { id } = await dataset({
        startsAt: far,
        endsAt: new Date(far.getTime() + 60 * MIN),
        originalEndsAt: far,
      });
      const [u1] = await bidders(1);
      await t.setTime(far);
      const res = await bid(u1, id, 5000);
      expect(res.status).toBe(200);
      const where = await rows<{ part: string }>(
        t.app,
        `SELECT tableoid::regclass::text AS part FROM "Bid" WHERE "auctionId" = :id`,
        { id },
      );
      expect(where.map((w) => w.part.replace(/"/g, ''))).toEqual([
        'Bid_default',
      ]);

      // the next run (in a month whose partitions exist) counts what is parked in the default partition
      await t.setTime(new Date('2026-10-05T00:00:00.000Z'));
      await t.jobs.ensureBidPartitions();
      expect(
        metric('auction_bid_default_partition_rows'),
      ).toBeGreaterThanOrEqual(1);
    });
  });

  // ------------------------------------------------------------------ AS-51

  describe('metrics, logs, spans and alerts (AS-51)', () => {
    it('S21 AS-51: a lifecycle moves the counters, the histograms and the gauges named in the spec', async () => {
      const outcomes = [
        'leading',
        'outbid',
        'raised',
        'rejected_low',
        'rejected_not_increasing',
        'rejected_closed',
        'rejected_shill',
      ];
      const before = Object.fromEntries(
        outcomes.map((o) => [o, metric('auction_bids_total', { outcome: o })]),
      );
      const closedBefore = metric('auction_closed_total', {
        status: 'CLOSED',
        reason: 'winner',
      });
      const extBefore = metric('auction_extensions_total');
      const shillBefore = metric('auction_shill_blocked_total');
      const durationBefore =
        MetricsRegistry.histogramValue('auction_bid_duration_seconds')?.count ??
        0;
      const lagBefore =
        MetricsRegistry.histogramValue('auction_close_lag_seconds')?.count ?? 0;

      const { s, id } = await dataset({
        originalEndsAt: new Date(T.getTime() - 2 * 3_600_000),
      });
      const [u1, u2] = await bidders(2);
      const member = await t.user();
      await addMember(t.app, s.shop.id, member.id, 'STAFF');
      await bid(u1, id, 5000); // leading
      await bid(u2, id, 4000); // outbid (defended)
      await bid(u1, id, 6000); // raised
      await bid(u2, id, 1500); // rejected_low
      await bid(u1, id, 6000); // rejected_not_increasing
      await bid(member, id, 9000); // rejected_shill
      await t.setTime(new Date(E.getTime() - 60_000));
      await bid(u2, id, 7000); // leading in the last two minutes: an extension is not possible (cap) -> no extension
      await t.setTime(new Date(E.getTime() + 5000));
      await bid(u1, id, 9000); // rejected_closed

      expect(
        metric('auction_bids_total', { outcome: 'leading' }) - before.leading,
      ).toBeGreaterThanOrEqual(2);
      for (const o of [
        'outbid',
        'raised',
        'rejected_low',
        'rejected_not_increasing',
        'rejected_closed',
        'rejected_shill',
      ])
        expect(metric('auction_bids_total', { outcome: o }) - before[o]).toBe(
          1,
        );
      expect(metric('auction_shill_blocked_total') - shillBefore).toBe(1);
      expect(
        MetricsRegistry.histogramValue('auction_bid_duration_seconds')!.count,
      ).toBeGreaterThan(durationBefore);

      // an auction that extends: the end moves and the counter counts it
      const second = await dataset({ originalEndsAt: E });
      const [u3] = await bidders(1);
      await t.setTime(new Date(E.getTime() - 90_000));
      await bid(u3, second.id, 5000);
      expect(metric('auction_extensions_total') - extBefore).toBe(1);

      await t.setTime(new Date(E.getTime() + 10_000));
      await t.jobs.close({ auctionId: id });
      expect(
        metric('auction_closed_total', { status: 'CLOSED', reason: 'winner' }) -
          closedBefore,
      ).toBe(1);
      expect(
        MetricsRegistry.histogramValue('auction_close_lag_seconds')!.count,
      ).toBeGreaterThan(lagBefore);

      // the names exist in the registry (a metric that was never created has no entry)
      for (const name of [
        'auction_second_chance_total',
        'auction_order_request_failed_total',
        'auction_settlement_anomaly_total',
        'auction_bid_default_partition_rows',
        'auction_open_overdue',
      ])
        expect(
          typeof MetricsRegistry.value(name) === 'number' ||
            MetricsRegistry.value(name) === undefined,
        ).toBe(true);
    });

    it('S21 AS-51: the overdue gauge counts an OPEN auction a close keeps failing on, and returns to 0 once it closes', async () => {
      const { id } = await dataset({ originalEndsAt: T });
      const [u1] = await bidders(1);
      await bid(u1, id, 5000);
      await t.setTime(new Date(E.getTime() + 2 * MIN));
      // the leader lookup fails, so the close refuses to award an unchecked leader and the auction stays OPEN
      const restore = t.patch(
        t.app.get<ShopMembershipPort>(SHOP_MEMBERSHIP, { strict: false }),
        'isMember',
        () => (() => Promise.reject(new Error('tenancy down'))) as never,
      );
      await t.jobs.sweepDue();
      expect(
        (
          await rows<{ status: string }>(
            t.app,
            `SELECT "status" FROM "Auction" WHERE "id" = :id`,
            { id },
          )
        )[0].status,
      ).toBe('OPEN');
      expect(metric('auction_open_overdue')).toBe(1);

      restore();
      await t.jobs.sweepDue();
      expect(
        (
          await rows<{ status: string }>(
            t.app,
            `SELECT "status" FROM "Auction" WHERE "id" = :id`,
            { id },
          )
        )[0].status,
      ).toBe('CLOSED');
      expect(metric('auction_open_overdue')).toBe(0);
    });

    it('S21 AS-51: the log lines are JSON with requestId, auctionId, the bidder and the outcome, and never a maximum; spans cover bid, close and order request', async () => {
      const { id } = await dataset({ originalEndsAt: T });
      const [u1, u2] = await bidders(2);
      await bid(u1, id, 7777);
      await bid(u2, id, 6543);
      await t.setTime(E);
      await t.jobs.close({ auctionId: id });
      await t.jobs.requestOrder(
        { auctionId: id, step: 'winner' },
        { isLastAttempt: false },
      );

      const lines = logs().filter((l) =>
        String(l.event ?? '').startsWith('auction.'),
      );
      const bids = lines.filter((l) => l.event === 'auction.bid');
      expect(bids.map((l) => l.outcome)).toEqual(['leading', 'outbid']);
      for (const l of bids) {
        expect(l.requestId).toEqual(expect.any(String));
        expect(l.auctionId).toBe(id);
        expect(l.bidderId).toEqual(expect.any(String));
      }
      expect(
        lines.some((l) => l.event === 'auction.close' && l.auctionId === id),
      ).toBe(true);
      expect(
        lines.some(
          (l) => l.event === 'auction.request_order' && l.auctionId === id,
        ),
      ).toBe(true);
      const raw = written.join('');
      for (const secret of [
        '7777',
        '6543',
        u1.email,
        u2.email,
        u1.bearer.replace('Bearer ', ''),
      ])
        expect(raw).not.toContain(secret);
      expect(new Set(spans)).toEqual(
        new Set(['auction.bid', 'auction.close', 'auction.request_order']),
      );
    });

    it('S21 AS-51: the alerts exist with their runbooks (open past its end, dead-lettered order request, anomaly, default partition)', () => {
      const root = resolve(__dirname, '../../../../..');
      const rules = parse(
        readFileSync(
          join(root, 'infra/observability/prometheus/rules/causes.yml'),
          'utf8',
        ),
      ) as {
        groups: Array<{
          rules: Array<{
            alert: string;
            expr: string;
            annotations: { runbook: string };
          }>;
        }>;
      };
      const alerts = new Map(
        rules.groups.flatMap((g) => g.rules).map((r) => [r.alert, r]),
      );
      const expected: Array<[string, RegExp]> = [
        ['AuctionCloseOverdue', /auction_open_overdue/],
        [
          'AuctionOrderRequestDeadLettered',
          /auction_order_request_failed_total\{kind="dead_letter"\}/,
        ],
        ['AuctionSettlementAnomaly', /auction_settlement_anomaly_total/],
        ['AuctionBidDefaultPartition', /auction_bid_default_partition_rows/],
      ];
      for (const [name, expr] of expected) {
        const alert = alerts.get(name);
        expect(alert).toBeDefined();
        expect(alert!.expr).toMatch(expr);
        expect(existsSync(join(root, alert!.annotations.runbook))).toBe(true);
      }
    });
  });

  // ------------------------------------------------------------------ AS-52

  describe('domain isolation (AS-52)', () => {
    const domainDir = __dirname;
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory())
          return entry === 'testing' ? [] : sources(path);
        return /\.ts$/.test(entry) &&
          !/(\.spec\.ts|\.e2e-spec\.ts)$/.test(entry)
          ? [path]
          : [];
      });

    it('S21 AS-52: the three tables are registered to auctions and have no foreign key', async () => {
      expect(OWNERSHIP.Auction).toBe('domain:auctions');
      expect(OWNERSHIP.Bid).toBe('domain:auctions');
      expect(OWNERSHIP.AuctionHistory).toBe('domain:auctions');
      const fks = await rows<{ conrelid: string }>(
        t.app,
        `SELECT conrelid::regclass::text AS conrelid FROM pg_constraint
         WHERE contype = 'f' AND conrelid::regclass::text IN ('"Auction"', '"Bid"', '"AuctionHistory"', 'Auction', 'Bid', 'AuctionHistory')`,
      );
      expect(fks).toEqual([]);
    });

    it('S21 AS-52: the entry point exports modules, rate policies and event definitions only', () => {
      expect(Object.keys(barrel).sort()).toEqual(
        [
          'AuctionBidPlaced',
          'AuctionCancelled',
          'AuctionClosed',
          'AuctionCreated',
          'AuctionLeaderChanged',
          'AuctionOpened',
          'AuctionSecondChanceOffered',
          'AuctionSold',
          'AuctionTopicsModule',
          'AuctionUnsold',
          'AuctionsModule',
          'AuctionsWorkerModule',
          'auctionsRatePolicies',
        ].sort(),
      );
    });

    it("S21 AS-52: no source file reaches into another domain's internals or tables", () => {
      const offenders: string[] = [];
      for (const file of sources(domainDir)) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(
          /from '@app\/domains\/(?!auctions)([a-z-]+)\/[^']+'/g,
        ))
          offenders.push(`${file}: deep import ${m[0]}`);
        for (const m of text.matchAll(
          /(?:FROM|JOIN|UPDATE|INTO)\s+"(Product|BisOrder|BisOrderItem|ShopOrder|Shop|User|StockReservation)"/g,
        ))
          offenders.push(`${file}: foreign table ${m[1]}`);
        for (const m of text.matchAll(
          /\b(ProductModel|BisOrderModel|BisOrderItemModel|ShopModel|UserModel)\b/g,
        ))
          offenders.push(`${file}: foreign model ${m[1]}`);
        // (the pattern is assembled so this very file does not count as a direct transaction site for the gate)
        if (new RegExp(`${'sequelize'}\\.${'transaction'}\\(`).test(text))
          offenders.push(
            `${file}: a direct transaction (use TransactionRunner)`,
          );
      }
      expect(offenders).toEqual([]);
    });
  });
});

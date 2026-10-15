import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TransactionRunner } from '@app/infrastructure/context';
import { UsageRecorded } from './application/events/usage-events';
import { EntitlementsService } from './application/entitlements.service';
import { UsageSettlementService } from './application/usage-settlement.service';
import { UsageLinesService } from './application/usage-lines.service';
import { USAGE_STORE, type UsageStorePort } from './domain/ports';
import { UsageRecordedConsumer } from './infra/usage.consumers';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import {
  applyS18Plans,
  seedInvoice,
  seedSubscription,
} from './testing/billing-seed';

const NOW = '2026-05-01T00:00:00.000Z';
const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Billing: usage and entitlement observability', () => {
  let t: BillingTestApp;

  beforeAll(async () => {
    t = await createBillingApp({ realUsage: true, structuredLogger: true });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    await applyS18Plans(t);
    t.clock.set(new Date(NOW));
  });

  it('S18 AS-57: 3 valid events, 1 duplicate, 1 poison message, 2 entitlement checks and 1 settlement conflict move exactly the metrics the spec names', async () => {
    const store = t.app.get<UsageStorePort>(USAGE_STORE, { strict: false });
    const entitlements = t.app.get(EntitlementsService, { strict: false });
    const lines = t.app.get(UsageLinesService, { strict: false });
    const settlement = t.app.get(UsageSettlementService, { strict: false });
    const runner = t.app.get(TransactionRunner, { strict: false });
    const shop = uuidv4();
    const sub = await seedSubscription(t, {
      subjectType: 'SHOP',
      subjectId: shop,
      plan: 'starter',
    });
    const before = {
      ingested: metric('usage_events_ingested_total', { metric_class: 'api' }),
      rejected: metric('usage_events_rejected_total', {
        reason: 'invalid_payload',
      }),
      checks: metric('entitlement_checks_total', {
        kind: 'get',
        outcome: 'ok',
      }),
      conflicts: metric('usage_settlement_conflicts_total'),
    };

    // usage: 3 valid, 1 duplicate of the first, 1 poison message whose payload must not reach a log line
    const event = (quantity: number, id: string = uuidv7()) => ({
      ...UsageRecorded.create(shop, 0, {
        metric: 'api.calls',
        quantity,
        ts: '2026-04-30T10:00:00.000Z',
      }),
      eventId: id,
    });
    const first = event(10);
    const poison = event(5);
    Object.assign(poison.payload, { quantity: -1, note: 'POISON-MARKER-7f3a' });
    const delivered = await t
      .deliver(UsageRecordedConsumer)
      .deliver(first, event(20), event(30), first, poison);
    expect(delivered.counts.applied).toBe(3);
    expect(delivered.counts.duplicate).toBe(1);
    expect(delivered.deadLetters).toHaveLength(1);

    // two entitlement checks
    await entitlements.get('SHOP', shop);
    await entitlements.get('SHOP', shop);

    // one settlement conflict: a plan settled by one invoice, then offered again by another
    const april = {
      start: new Date('2026-04-01T00:00:00.000Z'),
      end: new Date('2026-05-01T00:00:00.000Z'),
    };
    const plan = (
      await lines.linesFor({
        subscriptionId: sub.id,
        subjectId: shop,
        priceId: sub.priceId,
        periodStart: april.start,
        periodEnd: april.end,
        measuredAt: new Date(NOW),
        timeoutMs: 5_000,
      })
    ).settlement;
    const i1 = await seedInvoice(
      t,
      sub.id,
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    );
    const i2 = await seedInvoice(
      t,
      sub.id,
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    );
    await runner.run(() =>
      settlement.settle({
        invoiceId: i1,
        subscriptionId: sub.id,
        settlement: plan,
      }),
    );
    await expect(
      runner.run(() =>
        settlement.settle({
          invoiceId: i2,
          subscriptionId: sub.id,
          settlement: plan,
        }),
      ),
    ).rejects.toMatchObject({ code: 'settlement_conflict' });

    expect(metric('usage_events_ingested_total', { metric_class: 'api' })).toBe(
      before.ingested + 3,
    );
    expect(
      metric('usage_events_rejected_total', { reason: 'invalid_payload' }),
    ).toBe(before.rejected + 1);
    // the duplicate changed no total
    expect(
      await store.total(shop, {
        metric: 'api.calls',
        from: april.start,
        to: april.end,
      }),
    ).toBe(60);
    expect(
      metric('entitlement_checks_total', { kind: 'get', outcome: 'ok' }),
    ).toBe(before.checks + 2);
    expect(metric('usage_settlement_conflicts_total')).toBe(
      before.conflicts + 1,
    );
  });

  it('S18 AS-57: labels are closed enums: no subject, event or invoice id ever becomes one', () => {
    for (const name of [
      'usage_events_ingested_total',
      'usage_events_rejected_total',
      'usage_events_ignored_total',
      'entitlement_checks_total',
      'entitlement_invalidations_total',
      'entitlements_stale_served_total',
      'entitlements_cache_errors_total',
      'usage_settlement_conflicts_total',
      'usage_ledger_drift',
    ])
      for (const labels of MetricsRegistry.labelSets(name))
        for (const value of Object.values(labels))
          expect(String(value)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('S18 AS-57: log lines carry a request id and hold no payload, token or payment data', async () => {
    const { shopId, owner } = await t.shopWithOwner();
    await seedSubscription(t, {
      subjectType: 'SHOP',
      subjectId: shopId,
      plan: 'pro',
    });
    // a rejected message and a read, both of which log
    await t.deliver(UsageRecordedConsumer).deliver(
      Object.assign(
        {
          ...UsageRecorded.create(shopId, 0, {
            metric: 'api.calls',
            quantity: 1,
            ts: '2026-04-30T10:00:00.000Z',
          }),
          eventId: uuidv7(),
        },
        {},
      ),
    );
    const res = await t.as(owner).get(`/api/shops/${shopId}/usage`);
    expect(res.status).toBe(200);

    const lines = t
      .rawLogs()
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const forRequest = lines.filter(
      (line) =>
        String(line.msg ?? line.message ?? '').includes(
          `/shops/${shopId}/usage`,
        ) || line.req !== undefined,
    );
    expect(forRequest.length).toBeGreaterThan(0);
    for (const line of forRequest) expect(typeof line.requestId).toBe('string');
    const everything = t.rawLogs();
    expect(everything).not.toContain(owner.bearer.replace('Bearer ', ''));
    expect(everything).not.toMatch(
      /pm_ok|pm_declined|"paymentMethodRef"|POISON-MARKER/,
    );
  });
});

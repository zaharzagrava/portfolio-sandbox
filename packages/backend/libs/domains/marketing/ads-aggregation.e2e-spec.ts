import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import {
  minuteAggregateSchema,
  type AdClickRecord,
  type MinuteAggregate,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { waitFor } from '@app/test/utils/async-helpers';
import { testKafka } from '@app/test/utils/kafka-test';
import {
  ADS_AGGREGATES_TOPIC,
  ADS_CLICKS_DLQ_TOPIC,
  ADS_CLICKS_TOPIC,
} from './domain/ads-constants';
import { formatReceivedAt } from './domain/click-record';
import { clickKey } from './domain/hot-key-salt';
import { AdsWorkerModule } from './ads-worker.module';
import {
  AGGREGATOR_AUTOSTART,
  ClickAggregator,
} from './infra/click-aggregator.service';
import { ClickLogWriter } from './infra/click-log.writer';
import { AggregateWriter } from './infra/aggregate.writer';
import { ClickhouseAdReader } from './infra/clickhouse-ad.reader';
import {
  createAdsApp,
  resetAdsTopics,
  type AdsTestApp,
} from './testing/ads.fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Sponsored listings: click aggregation', () => {
  let t: AdsTestApp;
  let aggregator: ClickAggregator;
  const stoppers: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    t = await createAdsApp({
      extraImports: [AdsWorkerModule],
      spyProducer: false,
      customize: (builder) =>
        builder.overrideProvider(AGGREGATOR_AUTOSTART).useValue(false),
    });
    aggregator = t.app.get(ClickAggregator);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    await resetAdsTopics();
  });
  afterEach(async () => {
    await Promise.allSettled(stoppers.splice(0).map((stop) => stop()));
  });

  // ---- data -------------------------------------------------------------------------------------------------------

  const stamp = (offsetMs = 0) =>
    formatReceivedAt(new Date(t.clock.nowMs() + offsetMs));
  const record = (
    campaign: string,
    over: Partial<AdClickRecord> = {},
  ): AdClickRecord => ({
    click_id: uuidv7(),
    campaign_id: campaign,
    shop_id: uuidv4(),
    product_id: uuidv4(),
    received_at: stamp(-5_000),
    ip_hash: 'a'.repeat(32),
    viewer_hash: 'b'.repeat(32),
    valid: 1,
    invalid_reason: null,
    ...over,
  });
  const invalid = (campaign: string, over: Partial<AdClickRecord> = {}) =>
    record(campaign, { valid: 0, invalid_reason: 'ip_burst', ...over });

  type Outgoing = { key: string; value: string };
  const message = (r: AdClickRecord): Outgoing => ({
    key: clickKey(r.campaign_id, r.click_id),
    value: JSON.stringify(r),
  });
  const produce = async (topic: string, messages: Outgoing[]) => {
    const producer = testKafka().producer();
    await producer.connect();
    try {
      for (let i = 0; i < messages.length; i += 200)
        await producer.send({ topic, messages: messages.slice(i, i + 200) });
    } finally {
      await producer.disconnect();
    }
  };

  // ---- reading the log ----------------------------------------------------------------------------------------------

  /** What a read_committed reader sees on `topic` after `settleMs` of quiet (an aborted batch is never visible). */
  const readCommitted = async (topic: string, settleMs = 2_500) => {
    const consumer = testKafka().consumer({
      groupId: `rc-${uuidv4()}`,
      readUncommitted: false,
    });
    const seen: Array<{ value: string; headers: Record<string, string> }> = [];
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message: m }) =>
        void seen.push({
          value: m.value!.toString(),
          headers: Object.fromEntries(
            Object.entries(m.headers ?? {}).map(([k, v]) => [k, String(v)]),
          ),
        }),
    });
    await sleep(settleMs);
    await consumer.disconnect();
    return seen;
  };
  const aggregates = async (settleMs?: number): Promise<MinuteAggregate[]> =>
    (await readCommitted(ADS_AGGREGATES_TOPIC, settleMs)).map((m) =>
      minuteAggregateSchema.parse(JSON.parse(m.value)),
    );
  const totals = (rows: MinuteAggregate[], campaign?: string) =>
    rows
      .filter((r) => !campaign || r.campaign_id === campaign)
      .reduce(
        (sum, r) => ({
          clicks: sum.clicks + r.clicks,
          invalid: sum.invalid + r.invalid,
        }),
        { clicks: 0, invalid: 0 },
      );
  const committedOffsets = async (
    group: string,
    topic: string,
  ): Promise<number> => {
    const admin = testKafka().admin();
    await admin.connect();
    try {
      const [found] = await admin.fetchOffsets({
        groupId: group,
        topics: [topic],
      });
      return found.partitions.reduce(
        (sum, p) => sum + Math.max(0, Number(p.offset)),
        0,
      );
    } finally {
      await admin.disconnect();
    }
  };

  // ---- instances ----------------------------------------------------------------------------------------------------

  const fresh = () => ({
    groupId: `g-${uuidv4()}`,
    transactionalId: `tx-${uuidv4()}`,
  });
  const run = async (options: Parameters<ClickAggregator['start']>[0] = {}) => {
    const ids = { ...fresh(), ...options };
    const handle = await aggregator.start(ids);
    stoppers.push(() => handle.stop());
    return { handle, ...ids };
  };
  const writers = async () => {
    const aggregateWriter = await t.app
      .get(AggregateWriter)
      .start(`aw-${uuidv4()}`);
    const logWriter = await t.app.get(ClickLogWriter).start(`lw-${uuidv4()}`);
    stoppers.push(
      () => aggregateWriter.stop(),
      () => logWriter.stop(),
    );
  };
  const reader = () => t.app.get(ClickhouseAdReader);
  const hourOf = (receivedAt: string) =>
    `${receivedAt.slice(0, 10)}T${receivedAt.slice(11, 13)}`;

  // ---- scenarios ----------------------------------------------------------------------------------------------------

  it('S36 AS-43: 1,000 click records with duplicates and invalid ones aggregate to exactly the distinct valid and invalid counts', async () => {
    const campaign = uuidv4();
    const base = Array.from({ length: 950 }, (_, i) =>
      i < 30
        ? invalid(campaign, { received_at: stamp(-5_000 - (i % 3) * 60_000) })
        : record(campaign, { received_at: stamp(-5_000 - (i % 3) * 60_000) }),
    );
    const duplicates = base.slice(100, 150).map((r) => ({ ...r })); // 50 repeats of valid records
    const all = [...base, ...duplicates];
    expect(all).toHaveLength(1_000);
    await produce(ADS_CLICKS_TOPIC, all.map(message));

    const { groupId } = await run();

    await waitFor(
      async () => (await committedOffsets(groupId, ADS_CLICKS_TOPIC)) === 1_000,
      {
        description: 'all 1,000 offsets committed',
        timeoutMs: 40_000,
      },
    );
    const rows = await aggregates();
    expect(totals(rows, campaign)).toEqual({ clicks: 920, invalid: 30 });
    expect(new Set(rows.map((r) => r.source_partition)).size).toBeGreaterThan(
      1,
    ); // the salted keys spread over partitions
    expect(new Set(rows.map((r) => r.minute)).size).toBe(3);
  }, 90_000);

  it('S36 AS-44: killed after sending a batch and before committing: nothing is visible, and the restart equals a crash-free run', async () => {
    const campaign = uuidv4();
    const clicks = Array.from({ length: 300 }, () => record(campaign));
    await produce(ADS_CLICKS_TOPIC, clicks.map(message));
    const ids = fresh();

    let crashed!: () => void;
    const crashedOnce = new Promise<void>((resolve) => (crashed = resolve));
    const first = await run({
      ...ids,
      afterEmit: async () => {
        crashed();
        throw new Error('killed after send, before commit (injected)');
      },
    });
    await crashedOnce;
    await first.handle.stop();

    expect(await readCommitted(ADS_AGGREGATES_TOPIC)).toEqual([]);
    expect(await committedOffsets(ids.groupId, ADS_CLICKS_TOPIC)).toBe(0);

    await run(ids); // same group and transactional id: the batch is read again from the last committed offset
    await waitFor(
      async () =>
        (await committedOffsets(ids.groupId, ADS_CLICKS_TOPIC)) === 300,
      {
        description: 'offsets committed after the restart',
        timeoutMs: 40_000,
      },
    );
    expect(totals(await aggregates(), campaign)).toEqual({
      clicks: 300,
      invalid: 0,
    });
  }, 90_000);

  it('S36 AS-45: a zombie instance with the same transactional id is fenced: its commit is rejected and only the newer output exists', async () => {
    const campaign = uuidv4();
    await produce(
      ADS_CLICKS_TOPIC,
      Array.from({ length: 200 }, () => record(campaign)).map(message),
    );
    const transactionalId = `tx-${uuidv4()}`;
    const fenced = MetricsRegistry.value('ads_aggregator_fenced_total') ?? 0;

    let blocked!: () => void;
    let release!: () => void;
    const reachedHook = new Promise<void>((resolve) => (blocked = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const zombie = await run({
      transactionalId,
      afterEmit: async () => {
        blocked();
        await gate; // the old instance is "thought dead": it wakes up after the newer one took over
      },
    });
    await reachedHook;

    const newer = await run({ transactionalId }); // another group: it reads the same input from the start
    await waitFor(
      async () =>
        (await committedOffsets(newer.groupId, ADS_CLICKS_TOPIC)) === 200,
      {
        description: 'the newer instance committed',
        timeoutMs: 40_000,
      },
    );
    release();

    await waitFor(async () => zombie.handle.fenced, {
      description: 'the zombie is fenced',
    });
    await waitFor(
      async () =>
        (MetricsRegistry.value('ads_aggregator_fenced_total') ?? 0) >=
        fenced + 1,
      {
        description: 'the fenced metric',
      },
    );
    expect(totals(await aggregates(), campaign)).toEqual({
      clicks: 200,
      invalid: 0,
    }); // once, from the newer instance
    expect(await committedOffsets(zombie.groupId, ADS_CLICKS_TOPIC)).toBe(0);
  }, 120_000);

  it('S36 AS-46: an aggregate delivered twice has one effect, and the salted partials of a campaign-minute are summed', async () => {
    await writers();
    const campaign = uuidv4();
    const minute = `${stamp(-3_600_000 * 5).slice(0, 16)}:00`;
    const aggregate = (
      partition: number,
      offset: number,
      clicks: number,
    ): MinuteAggregate => ({
      campaign_id: campaign,
      minute,
      source_partition: partition,
      first_offset: offset,
      clicks,
      invalid: 0,
    });
    const send = (rows: MinuteAggregate[]) =>
      produce(
        ADS_AGGREGATES_TOPIC,
        rows.map((row) => ({
          key: row.campaign_id,
          value: JSON.stringify(row),
        })),
      );
    const hour = hourOf(minute);
    const total = async () =>
      (await reader().clicksByCampaign(hour)).find(
        (r) => r.campaignId === campaign,
      )?.clicks ?? 0;

    await send([aggregate(3, 100, 30), aggregate(3, 100, 30)]);
    await waitFor(async () => (await total()) > 0, {
      description: 'the aggregate is stored',
    });
    await sleep(1_000);
    expect(await total()).toBe(30); // not 60

    await send(Array.from({ length: 10 }, (_, p) => aggregate(p, 500 + p, 5)));
    await waitFor(async () => (await total()) >= 80, {
      description: 'the partials are stored',
    });
    expect(await total()).toBe(30 + 10 * 5); // the 30 of partition 3 offset 100, plus ten partials of 5
  }, 60_000);

  it('S36 AS-47: poison messages are dead-lettered with a reason and never block the stream; a rewound consumer has one effect', async () => {
    await writers();
    const campaign = uuidv4();
    const good = Array.from({ length: 5 }, () => record(campaign));
    const poison: Array<[string, string]> = [
      ['invalid_json', 'this is {not json'],
      ['schema', JSON.stringify({ ...record(campaign), click_id: undefined })],
      ['valid_out_of_range', JSON.stringify({ ...record(campaign), valid: 2 })],
      [
        'schema',
        JSON.stringify({ ...record(campaign), campaign_id: 'not-a-uuid' }),
      ],
      [
        'received_at_future',
        JSON.stringify(record(campaign, { received_at: stamp(10 * 60_000) })),
      ],
      [
        'received_at_stale',
        JSON.stringify(
          record(campaign, { received_at: stamp(-8 * 86_400_000) }),
        ),
      ],
    ];
    await produce(ADS_CLICKS_TOPIC, [
      ...good.slice(0, 2).map(message),
      ...poison.map(([, value]) => ({ key: 'poison', value })),
      ...good.slice(2).map(message),
    ]);
    const total = good.length + poison.length;

    const first = await run();
    await waitFor(
      async () =>
        (await committedOffsets(first.groupId, ADS_CLICKS_TOPIC)) === total,
      {
        description: 'the offsets advanced past the poison messages',
        timeoutMs: 40_000,
      },
    );

    const dead = await readCommitted(ADS_CLICKS_DLQ_TOPIC);
    expect(dead.map((m) => m.headers.reason).sort()).toEqual(
      poison.map(([reason]) => reason).sort(),
    );
    expect(totals(await aggregates(), campaign)).toEqual({
      clicks: 5,
      invalid: 0,
    });
    const hour = hourOf(good[0].received_at);
    const stored = async () =>
      (await reader().clicksByCampaign(hour)).find(
        (r) => r.campaignId === campaign,
      )?.clicks ?? 0;
    await waitFor(async () => (await stored()) === 5, {
      description: 'the valid clicks reach billing',
    });

    // the consumer is rewound to the start: the same valid messages are delivered again
    await first.handle.stop();
    const admin = testKafka().admin();
    await admin.connect();
    try {
      const partitions = (await admin.fetchTopicOffsets(ADS_CLICKS_TOPIC)).map(
        (o) => ({
          partition: o.partition,
          offset: o.low,
        }),
      );
      await admin.setOffsets({
        groupId: first.groupId,
        topic: ADS_CLICKS_TOPIC,
        partitions,
      });
    } finally {
      await admin.disconnect();
    }
    await run({
      groupId: first.groupId,
      transactionalId: first.transactionalId,
    });
    await waitFor(
      async () =>
        (await readCommitted(ADS_AGGREGATES_TOPIC, 1_000)).length > 0 &&
        (await committedOffsets(first.groupId, ADS_CLICKS_TOPIC)) === total,
      {
        description: 'the rewound consumer caught up',
        timeoutMs: 40_000,
      },
    );
    await sleep(1_500);
    expect(await stored()).toBe(5); // one effect, not ten
  }, 120_000);

  it('S36 AS-48: a late click is counted in its own minute and measured; the hour already charged is not touched', async () => {
    await writers();
    const campaign = uuidv4();
    const late = record(campaign, { received_at: stamp(-30 * 60_000) });
    const hour = hourOf(late.received_at);
    await t.sql(
      `INSERT INTO "AdCampaign" ("id", "shopId", "productId", "category", "cpcMinor", "dailyBudgetMinor") VALUES (:id, :shop, :product, 'audio', 25, 1000) RETURNING 1`,
      { id: campaign, shop: late.shop_id, product: late.product_id },
    );
    await t.sql(
      `INSERT INTO "AdBillingRun" ("campaignId", "hour", "state", "source", "clicks", "billableClicks", "cappedClicks", "amountMinor", "ledgerReference", "chargedAt")
       VALUES (:id, :hour, 'CHARGED', 'stream', 10, 10, 0, 250, :ref, now()) RETURNING 1`,
      {
        id: campaign,
        hour: new Date(`${hour}:00:00.000Z`),
        ref: `ad:${campaign}:${hour}`,
      },
    );
    const lateBefore = MetricsRegistry.value('ads_late_clicks_total') ?? 0;
    await produce(ADS_CLICKS_TOPIC, [message(late)]);

    await run();

    await waitFor(async () => (await aggregates(500)).length > 0, {
      description: 'the aggregate exists',
      timeoutMs: 30_000,
    });
    const [row] = await aggregates();
    expect(row.minute).toBe(`${late.received_at.slice(0, 16)}:00`); // its own minute, not the current one
    expect(MetricsRegistry.value('ads_late_clicks_total')).toBe(lateBefore + 1);
    const [run0] = await t.sql<{
      clicks: number;
      amountMinor: string;
      state: string;
    }>(
      `SELECT "clicks", "amountMinor", "state" FROM "AdBillingRun" WHERE "campaignId" = :id`,
      { id: campaign },
    );
    expect(run0).toEqual({ clicks: 10, amountMinor: '250', state: 'CHARGED' });
  }, 60_000);

  it('S36 AS-49: the same click id written twice with different verdicts is read once, with the first recorded verdict', async () => {
    await writers();
    const day = '2026-10-05';
    const at = (s: string) => `${day} ${s}`;
    const campaign = uuidv4();
    const x = record(campaign, { received_at: at('10:00:00.000') });
    const y = record(campaign, {
      received_at: at('10:00:00.000'),
      valid: 0,
      invalid_reason: 'ip_burst',
    });
    await produce(ADS_CLICKS_TOPIC, [
      message(x),
      message({
        ...x,
        received_at: at('10:00:02.000'),
        valid: 0,
        invalid_reason: 'ip_burst',
      }),
      message(y),
      message({
        ...y,
        received_at: at('10:00:01.000'),
        valid: 1,
        invalid_reason: null,
      }),
    ]);

    await waitFor(
      async () =>
        Number(
          (
            await t.app
              .get(ClickHouseService)
              .query<{ n: string }>(
                `SELECT count() AS n FROM ad_clicks_log WHERE campaign_id = {c:String}`,
                { c: campaign },
              )
          )[0].n,
        ) === 4,
      { description: 'all four rows are stored', timeoutMs: 40_000 },
    );
    const exact = (await reader().exactValidClicksByHour(day)).filter(
      (r) => r.campaignId === campaign,
    );
    expect(exact).toEqual([
      { campaignId: campaign, hour: `${day}T10`, clicks: 1 },
    ]); // x counts (valid first), y does not
  }, 60_000);
});

import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  adBillingPageSchema,
  type AdBillingItem,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import {
  LEDGER_ACCOUNTS,
  LedgerService,
  shopAccount,
} from '@app/domains/payments';
import { inParallel } from '@app/test/utils/async-helpers';
import { AdsWorkerModule } from './ads-worker.module';
import { LEDGER_PORT } from './domain/ads-ports';
import { AGGREGATOR_AUTOSTART } from './infra/click-aggregator.service';
import { LedgerAdapter } from './infra/ledger.adapter';
import {
  createAdsApp,
  type AdsTestApp,
  type Team,
} from './testing/ads.fixtures';

/** Hours are `YYYY-MM-DDTHH` (UTC). A fixed day in the past keeps every boundary explicit. */
const H = '2026-10-05T10';
const at = (hour: string, minutes = 0) =>
  new Date(Date.parse(`${hour}:00:00.000Z`) + minutes * 60_000);
const plusHours = (hour: string, n: number) =>
  at(hour, n * 60)
    .toISOString()
    .slice(0, 13);

describe('Sponsored listings: billing and reconciliation', () => {
  let t: AdsTestApp;
  let team: Team;

  beforeAll(async () => {
    t = await createAdsApp({
      extraImports: [AdsWorkerModule],
      spyProducer: false,
      customize: (builder) =>
        builder.overrideProvider(AGGREGATOR_AUTOSTART).useValue(false),
      ports: [{ dep: 'ledger', token: LEDGER_PORT, real: LedgerAdapter }],
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    team = await t.team();
  });

  // ---- data ---------------------------------------------------------------------------------------------------------

  const clickhouse = () => t.app.get(ClickHouseService).getClient();
  /** Minute aggregates of one hour, as the aggregate writer would have stored them (spread over source partitions). */
  const aggregate = async (
    campaignId: string,
    hour: string,
    clicks: number,
    partitions = 4,
  ) => {
    const per = Math.floor(clicks / partitions);
    const rows = Array.from({ length: partitions }, (_, p) => ({
      campaign_id: campaignId,
      minute: at(hour, 5 + p)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' '),
      source_partition: p,
      first_offset: 1_000 + p,
      clicks: p === partitions - 1 ? clicks - per * (partitions - 1) : per,
      invalid: 0,
    }));
    await clickhouse().insert({
      table: 'ad_click_minute_v2',
      format: 'JSONEachRow',
      values: rows,
    });
  };
  const newCampaign = async (cpcMinor = 25, dailyBudgetMinor = 10_000) =>
    (await t.campaign(team, { cpcMinor, dailyBudgetMinor })).campaign;
  /** A run written straight into the table: set-up for "what was billed earlier today". */
  const seedRun = (
    campaignId: string,
    hour: string,
    over: {
      state?: string;
      clicks?: number;
      amountMinor?: number;
      source?: string;
    } = {},
  ) =>
    t.sql(
      `INSERT INTO "AdBillingRun" ("campaignId", "hour", "state", "source", "clicks", "billableClicks", "cappedClicks",
                                    "amountMinor", "ledgerReference", "chargedAt")
       VALUES (:campaignId, :hour, :state, :source, :clicks, :clicks, 0, :amount, :ref,
               CASE WHEN :state = 'CHARGED' THEN now() END) RETURNING 1`,
      {
        campaignId,
        hour: at(hour),
        state: over.state ?? 'CHARGED',
        source: over.source ?? 'stream',
        clicks: over.clicks ?? 0,
        amount: over.amountMinor ?? 0,
        ref: `ad:${campaignId}:${hour}`,
      },
    );
  const runs = (campaignId: string) =>
    t.sql<{
      hour: Date;
      state: string;
      source: string;
      clicks: number;
      billableClicks: number;
      cappedClicks: number;
      amountMinor: string;
      ledgerReference: string;
      journalId: string | null;
    }>(
      `SELECT "hour", "state", "source", "clicks", "billableClicks", "cappedClicks", "amountMinor", "ledgerReference", "journalId"
         FROM "AdBillingRun" WHERE "campaignId" = :campaignId ORDER BY "hour"`,
      { campaignId },
    );
  const journals = (reference: string) =>
    t.sql<{ id: string; kind: string }>(
      `SELECT "id", "kind" FROM "LedgerJournal" WHERE "reference" = :reference`,
      { reference },
    );
  const balanceOf = async (account: string) =>
    (
      await t.app
        .get(LedgerService)
        .getBalances({ accountIds: [account], currency: 'EUR' })
    ).get(account)!.balanceMinor;
  const shopBalance = () => balanceOf(shopAccount(team.shop.id));
  const feesBalance = () => balanceOf(LEDGER_ACCOUNTS.PLATFORM_FEES);
  /** The clock where the job for `hour` may run: 7 minutes after the hour closed. */
  const afterClose = (hour: string) => t.clock.set(at(hour, 60 + 7));
  const bill = (hour?: string) =>
    t.runJob('ads.bill-hour', hour ? { hour } : {});

  // ---- hourly charge ------------------------------------------------------------------------------------------------

  describe('hourly charge', () => {
    it('S36 AS-50: 40 valid clicks at CPC 25 are charged once: run CHARGED, an AD_CHARGE journal with the stable reference, balances moved', async () => {
      const campaign = await newCampaign(25, 10_000);
      await aggregate(campaign.id, H, 40);
      afterClose(H);
      const charged =
        MetricsRegistry.value('ads_billing_charged_minor_total') ?? 0;

      await bill(H);

      const [run] = await runs(campaign.id);
      expect(run).toMatchObject({
        state: 'CHARGED',
        source: 'stream',
        clicks: 40,
        billableClicks: 40,
        cappedClicks: 0,
        amountMinor: '1000',
        ledgerReference: `ad:${campaign.id}:${H}`,
      });
      expect(run.journalId).not.toBeNull();
      const [journal] = await journals(`ad:${campaign.id}:${H}`);
      expect(journal).toMatchObject({ id: run.journalId, kind: 'AD_CHARGE' });
      expect(await shopBalance()).toBe(-1_000);
      expect(await feesBalance()).toBe(1_000);
      expect(MetricsRegistry.value('ads_billing_charged_minor_total')).toBe(
        charged + 1_000,
      );
    });

    it('S36 AS-51: a second run and two racing runs for the same hour charge once', async () => {
      const campaign = await newCampaign();
      await aggregate(campaign.id, H, 40);
      afterClose(H);
      await bill(H);

      await bill(H);
      await inParallel(2, () => bill(H));

      expect(await runs(campaign.id)).toHaveLength(1);
      expect(await journals(`ad:${campaign.id}:${H}`)).toHaveLength(1);
      expect(await shopBalance()).toBe(-1_000);
    });

    it('S36 AS-51: two runs racing from the start give one run row, one journal and one charge', async () => {
      const campaign = await newCampaign();
      await aggregate(campaign.id, H, 40);
      afterClose(H);

      const results = await inParallel(2, () => bill(H));

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await runs(campaign.id)).toHaveLength(1);
      expect(await journals(`ad:${campaign.id}:${H}`)).toHaveLength(1);
      expect(await shopBalance()).toBe(-1_000);
      expect((await runs(campaign.id))[0].state).toBe('CHARGED');
    });

    describe('S36 AS-52: a crash between the run row and the journal converges', () => {
      it('a ledger that refuses the first posting leaves the run PENDING with no journal; the next run posts once', async () => {
        const campaign = await newCampaign();
        await aggregate(campaign.id, H, 40);
        afterClose(H);
        t.faults.set('ledger.post', { kind: 'down', times: 1 });

        await expect(bill(H)).rejects.toThrow();

        const [pending] = await runs(campaign.id);
        expect(pending).toMatchObject({
          state: 'PENDING',
          amountMinor: '1000',
          journalId: null,
        });
        expect(await journals(`ad:${campaign.id}:${H}`)).toHaveLength(0);
        expect(await shopBalance()).toBe(0);

        await bill(H);

        const [done] = await runs(campaign.id);
        expect(done).toMatchObject({ state: 'CHARGED', amountMinor: '1000' });
        expect(await journals(`ad:${campaign.id}:${H}`)).toHaveLength(1);
        expect(await shopBalance()).toBe(-1_000);
      });

      it('a journal that was posted before the process died: the ledger answers created:false, the run becomes CHARGED, no second journal', async () => {
        const campaign = await newCampaign();
        await aggregate(campaign.id, H, 40);
        await seedRun(campaign.id, H, {
          state: 'PENDING',
          clicks: 40,
          amountMinor: 1_000,
        });
        const posted = await t.app.get(LedgerAdapter).post({
          kind: 'AD_CHARGE',
          reference: `ad:${campaign.id}:${H}`,
          shopId: team.shop.id,
          chargeMinor: 1_000,
        });
        expect(posted.created).toBe(true);
        afterClose(H);

        await bill(H);

        const [run] = await runs(campaign.id);
        expect(run).toMatchObject({
          state: 'CHARGED',
          journalId: posted.journalId,
        });
        expect(await journals(`ad:${campaign.id}:${H}`)).toHaveLength(1);
        expect(await shopBalance()).toBe(-1_000);
      });
    });

    it('S36 AS-53: the daily budget caps the charge across hours; the budget restarts at 00:00 UTC', async () => {
      const campaign = await newCampaign(25, 1_000);
      const [h1, h2, h3] = [H, plusHours(H, 1), plusHours(H, 2)];
      await aggregate(campaign.id, h1, 30);
      await aggregate(campaign.id, h2, 20);
      await aggregate(campaign.id, h3, 5);

      for (const hour of [h1, h2, h3]) {
        afterClose(hour);
        await bill(hour);
      }

      const [r1, r2, r3] = await runs(campaign.id);
      expect(r1).toMatchObject({
        amountMinor: '750',
        billableClicks: 30,
        cappedClicks: 0,
        state: 'CHARGED',
      });
      expect(r2).toMatchObject({
        amountMinor: '250',
        clicks: 20,
        billableClicks: 10,
        cappedClicks: 10,
      });
      expect(r3).toMatchObject({
        amountMinor: '0',
        clicks: 5,
        billableClicks: 0,
        cappedClicks: 5,
        state: 'CHARGED',
        journalId: null,
      });
      expect(await journals(`ad:${campaign.id}:${h3}`)).toHaveLength(0);
      expect(await shopBalance()).toBe(-1_000);

      // hour 23 of a day and hour 0 of the next: the budget restarts
      const d1 = '2026-10-06T23';
      const d2 = '2026-10-07T00';
      await aggregate(campaign.id, d1, 40);
      await aggregate(campaign.id, d2, 10);
      for (const hour of [d1, d2]) {
        afterClose(hour);
        await bill(hour);
      }
      const all = await runs(campaign.id);
      expect(
        all
          .filter((r) => r.hour.toISOString().startsWith('2026-10-06'))
          .map((r) => r.amountMinor),
      ).toEqual(['1000']);
      expect(
        all
          .filter((r) => r.hour.toISOString().startsWith('2026-10-07'))
          .map((r) => r.amountMinor),
      ).toEqual(['250']);
    });

    it.each([
      ['remaining 24 of 25: no click is billed', 976, 3, 0, 3, 0],
      ['remaining 25: exactly one click', 975, 3, 1, 2, 25],
      [
        'remaining equal to clicks x CPC: all billed, none capped',
        925,
        3,
        3,
        0,
        75,
      ],
    ])(
      'S36 AS-54: whole clicks only: %s',
      async (_name, earlier, clicks, billable, capped, amount) => {
        const campaign = await newCampaign(25, 1_000);
        await seedRun(campaign.id, H, {
          clicks: Math.round(earlier / 25),
          amountMinor: earlier,
        });
        const next = plusHours(H, 1);
        await aggregate(campaign.id, next, clicks, 1);
        afterClose(next);

        await bill(next);

        const run = (await runs(campaign.id)).find(
          (r) => r.hour.getTime() === at(next).getTime(),
        )!;
        expect(run).toMatchObject({
          billableClicks: billable,
          cappedClicks: capped,
          amountMinor: String(amount),
          clicks,
        });
      },
    );

    describe('S36 AS-55: overdraw, ended campaigns, orphans', () => {
      it('a shop with balance 0 is charged into the negative, and an ended campaign’s last hour is still billed', async () => {
        const campaign = await newCampaign();
        expect(await shopBalance()).toBe(0);
        await t.act(team.owner, team.shop.id, campaign.id, 'end');
        await aggregate(campaign.id, H, 8);
        afterClose(H);

        await bill(H);

        expect(await shopBalance()).toBe(-200);
        expect((await runs(campaign.id))[0]).toMatchObject({
          state: 'CHARGED',
          amountMinor: '200',
        });
      });

      it('aggregates of a campaign that has no row are skipped and counted, and charge nothing', async () => {
        const orphan = uuidv4();
        const campaign = await newCampaign();
        await aggregate(orphan, H, 12);
        await aggregate(campaign.id, H, 4);
        afterClose(H);
        const before =
          MetricsRegistry.value('ads_billing_orphan_aggregate_total') ?? 0;

        await bill(H);

        expect(
          MetricsRegistry.value('ads_billing_orphan_aggregate_total'),
        ).toBe(before + 1);
        expect(await runs(orphan)).toEqual([]);
        expect(await journals(`ad:${orphan}:${H}`)).toEqual([]);
        expect(await runs(campaign.id)).toHaveLength(1);
      });
    });

    describe('S36 AS-56: which hour is billed', () => {
      it('with no payload the last closed hour is billed, never the open one', async () => {
        const campaign = await newCampaign();
        await aggregate(campaign.id, H, 10);
        await aggregate(campaign.id, plusHours(H, 1), 10); // the hour that is still open
        afterClose(H);

        await bill();

        const rows = await runs(campaign.id);
        expect(rows.map((r) => r.hour.toISOString().slice(0, 13))).toEqual([H]);
      });

      it('an explicit hour that has not closed (or not for 5 minutes yet) is refused and nothing is written', async () => {
        const campaign = await newCampaign();
        await aggregate(campaign.id, H, 10);

        t.clock.set(at(H, 30)); // the hour is still open
        await expect(bill(H)).rejects.toThrow(/hour_not_closed/);
        t.clock.set(at(H, 60 + 3)); // closed, but the aggregates may not be complete yet
        await expect(bill(H)).rejects.toThrow(/hour_not_closed/);

        expect(await runs(campaign.id)).toEqual([]);
        expect(await shopBalance()).toBe(0);
      });

      it('a campaign with no aggregates for the hour gets no run row', async () => {
        const quiet = await newCampaign();
        const busy = (await t.campaign(team, { cpcMinor: 25 })).campaign;
        await aggregate(busy.id, H, 4);
        afterClose(H);

        await bill(H);

        expect(await runs(quiet.id)).toEqual([]);
        expect(await runs(busy.id)).toHaveLength(1);
      });
    });
  });

  // ---- reconciliation -----------------------------------------------------------------------------------------------

  describe('daily reconciliation', () => {
    const D = '2026-10-05';
    /** The schedule fires at 02:30 UTC of the following day. */
    const nextMorning = (day = D) =>
      new Date(
        Date.parse(`${day}T00:00:00.000Z`) + 86_400_000 + 2.5 * 3_600_000,
      );
    const stamp = (day: string, time: string) => `${day} ${time}`;

    let click = 0;
    const raw = (
      campaignId: string,
      receivedAt: string,
      over: { valid?: 0 | 1; clickId?: string; reason?: string | null } = {},
    ) => ({
      click_id:
        over.clickId ??
        `00000000-0000-4000-8000-${String(++click).padStart(12, '0')}`,
      campaign_id: campaignId,
      shop_id: team.shop.id,
      product_id: uuidv4(),
      received_at: receivedAt,
      ip_hash: 'a'.repeat(32),
      viewer_hash: 'b'.repeat(32),
      valid: over.valid ?? 1,
      invalid_reason:
        (over.valid ?? 1) === 1 ? null : (over.reason ?? 'ip_burst'),
    });
    const insertRaw = (rows: ReturnType<typeof raw>[]) =>
      clickhouse().insert({
        table: 'ad_clicks_log',
        format: 'JSONEachRow',
        values: rows,
      });
    /** `n` distinct valid clicks spread over the minutes of an hour (`YYYY-MM-DDTHH`). */
    const validClicks = (campaignId: string, hour: string, n: number) =>
      Array.from({ length: n }, (_, i) =>
        raw(
          campaignId,
          stamp(
            hour.slice(0, 10),
            `${hour.slice(11, 13)}:${String(i % 60).padStart(2, '0')}:30.000`,
          ),
        ),
      );
    const adjustments = (campaignId: string) =>
      t.sql<{
        hour: Date;
        sequence: number;
        deltaMinor: string;
        deltaClicks: number;
        state: string;
        ledgerReference: string;
        postedAt: Date | null;
        journalId: string | null;
      }>(
        `SELECT "hour", "sequence", "deltaMinor", "deltaClicks", "state", "ledgerReference", "postedAt", "journalId"
           FROM "AdBillingAdjustment" WHERE "campaignId" = :campaignId ORDER BY "hour", "sequence"`,
        { campaignId },
      );
    const reconRuns = (day = D) =>
      t.sql<{
        status: string;
        reason: string | null;
        hoursChecked: number;
        hoursAdjusted: number;
        netDeltaMinor: string;
      }>(
        `SELECT "status", "reason", "hoursChecked", "hoursAdjusted", "netDeltaMinor" FROM "AdReconciliationRun"
          WHERE "day" = :day ORDER BY "startedAt", "id"`,
        { day },
      );
    const reconcile = (day?: string) =>
      t.runJob('ads.reconcile-day', day ? { day } : {});
    /** The hourly path bills `clicks` for the hour, then time moves to the next morning. */
    const streamBilled = async (
      campaignId: string,
      hour: string,
      clicks: number,
    ) => {
      await aggregate(campaignId, hour, clicks);
      afterClose(hour);
      await bill(hour);
    };
    const net = async (campaignId: string, hour: string) => {
      const [run] = (await runs(campaignId)).filter(
        (r) => r.hour.getTime() === at(hour).getTime(),
      );
      const adjusted = (await adjustments(campaignId))
        .filter(
          (a) =>
            a.hour.getTime() === at(hour).getTime() && a.state === 'POSTED',
        )
        .reduce((sum, a) => sum + Number(a.deltaMinor), 0);
      return Number(run.amountMinor) + adjusted;
    };

    it('S36 AS-58: an over-billed hour is refunded by one ADJUSTMENT, the net is exact, and a second run changes nothing', async () => {
      const campaign = await newCampaign(25, 100_000);
      await streamBilled(campaign.id, H, 12);
      expect(await shopBalance()).toBe(-300);
      const ids = Array.from(
        { length: 10 },
        () => `00000000-0000-4000-8000-${String(++click).padStart(12, '0')}`,
      );
      await insertRaw([
        ...ids.map((clickId) =>
          raw(campaign.id, stamp(D, '10:20:00.000'), { clickId }),
        ),
        raw(campaign.id, stamp(D, '10:21:00.000'), { clickId: ids[0] }), // a duplicate of a counted click
        raw(campaign.id, stamp(D, '10:22:00.000'), { valid: 0 }), // an invalid one
      ]);
      t.clock.set(nextMorning());

      await reconcile(D);

      const [adjustment] = await adjustments(campaign.id);
      expect(adjustment).toMatchObject({
        sequence: 1,
        deltaMinor: '-50',
        deltaClicks: -2,
        state: 'POSTED',
        ledgerReference: `ad-adj:${campaign.id}:${H}:1`,
      });
      expect(await journals(`ad-adj:${campaign.id}:${H}:1`)).toEqual([
        expect.objectContaining({ kind: 'ADJUSTMENT' }),
      ]);
      expect(await net(campaign.id, H)).toBe(250);
      expect(await shopBalance()).toBe(-250);
      expect(await feesBalance()).toBe(250);

      await reconcile(D);
      expect(await adjustments(campaign.id)).toHaveLength(1);
      expect(await shopBalance()).toBe(-250);
    });

    it('S36 AS-59: an under-billed hour is charged the difference', async () => {
      const campaign = await newCampaign(25, 100_000);
      await streamBilled(campaign.id, H, 7);
      await insertRaw(validClicks(campaign.id, H, 10));
      t.clock.set(nextMorning());

      await reconcile(D);

      const [adjustment] = await adjustments(campaign.id);
      expect(adjustment).toMatchObject({
        deltaMinor: '75',
        deltaClicks: 3,
        state: 'POSTED',
      });
      expect(await net(campaign.id, H)).toBe(250);
      expect(await shopBalance()).toBe(-250);
    });

    it('S36 AS-60: an hour the stream path missed is charged with the reference the hourly job would use, and the hourly job then posts nothing', async () => {
      const campaign = await newCampaign(25, 100_000);
      await insertRaw(validClicks(campaign.id, H, 10));
      t.clock.set(nextMorning());

      await reconcile(D);

      const [run] = await runs(campaign.id);
      expect(run).toMatchObject({
        source: 'reconciliation',
        state: 'CHARGED',
        clicks: 10,
        amountMinor: '250',
        ledgerReference: `ad:${campaign.id}:${H}`,
      });
      expect(await journals(`ad:${campaign.id}:${H}`)).toEqual([
        expect.objectContaining({ kind: 'AD_CHARGE' }),
      ]);
      expect(await adjustments(campaign.id)).toEqual([]);

      await aggregate(campaign.id, H, 10); // the stream path finally delivers the same clicks
      await bill(H);
      expect(await runs(campaign.id)).toHaveLength(1);
      expect(await shopBalance()).toBe(-250);
    });

    describe('S36 AS-61: the cap applies to the exact recomputation', () => {
      const hours = [`${D}T10`, `${D}T11`, `${D}T12`];

      it('no adjustment when the stream path capped correctly', async () => {
        const campaign = await newCampaign(25, 1_000);
        for (const [i, clicks] of [30, 20, 5].entries())
          await insertRaw(validClicks(campaign.id, hours[i], clicks));
        for (const [i, clicks] of [30, 10, 0].entries()) {
          if (clicks > 0) await aggregate(campaign.id, hours[i], clicks);
        }
        for (const hour of hours.slice(0, 2)) {
          afterClose(hour);
          await bill(hour);
        }
        t.clock.set(nextMorning());

        await reconcile(D);

        expect(await adjustments(campaign.id)).toEqual([]);
        expect((await runs(campaign.id)).map((r) => r.amountMinor)).toEqual([
          '750',
          '250',
        ]);
        expect(await shopBalance()).toBe(-1_000);
        // the hour with 5 exact clicks past the budget bills 0: no run is needed for it
      });

      it('a stream path that billed past the budget by mistake is refunded: −250 and −125', async () => {
        const campaign = await newCampaign(25, 1_000);
        for (const [i, clicks] of [30, 20, 5].entries())
          await insertRaw(validClicks(campaign.id, hours[i], clicks));
        for (const [i, amount] of [750, 500, 125].entries())
          await seedRun(campaign.id, hours[i], {
            clicks: amount / 25,
            amountMinor: amount,
          });
        t.clock.set(nextMorning());

        await reconcile(D);

        expect(
          (await adjustments(campaign.id)).map((a) => [
            a.hour.toISOString().slice(0, 13),
            a.deltaMinor,
          ]),
        ).toEqual([
          [hours[1], '-250'],
          [hours[2], '-125'],
        ]);
        expect(await net(campaign.id, hours[1])).toBe(250);
        expect(await net(campaign.id, hours[2])).toBe(0);
      });
    });

    describe('S36 AS-62: a closed day is never rewritten', () => {
      it('a late click becomes an adjustment dated now that names the original hour; the closed rows are unchanged', async () => {
        const campaign = await newCampaign(25, 100_000);
        await streamBilled(campaign.id, H, 10);
        const first = validClicks(campaign.id, H, 10);
        await insertRaw(first);
        t.clock.set(nextMorning());
        await reconcile(D);
        expect(await reconRuns()).toEqual([
          expect.objectContaining({ status: 'COMPLETED' }),
        ]);
        const closedRun = await runs(campaign.id);
        const closedJournal = await journals(`ad:${campaign.id}:${H}`);

        await insertRaw(
          validClicks(campaign.id, H, 3).map((r) => ({
            ...r,
            received_at: stamp(D, '10:50:00.000'),
          })),
        );
        t.clock.set(new Date(nextMorning().getTime() + 86_400_000)); // the next schedule
        await reconcile();

        const [adjustment] = await adjustments(campaign.id);
        expect(adjustment).toMatchObject({
          deltaMinor: '75',
          ledgerReference: `ad-adj:${campaign.id}:${H}:1`,
          state: 'POSTED',
        });
        expect(adjustment.postedAt!.getTime()).toBe(t.clock.nowMs()); // dated at its posting time
        expect(await runs(campaign.id)).toEqual(closedRun);
        expect(await journals(`ad:${campaign.id}:${H}`)).toEqual(closedJournal);
        expect(await net(campaign.id, H)).toBe(325);
      });

      it('the schedule re-examines the last three closed days only; an explicit day older than that is processed the same way', async () => {
        const campaign = await newCampaign(25, 100_000);
        const old = '2026-09-20';
        const oldHour = `${old}T10`;
        await insertRaw(validClicks(campaign.id, oldHour, 4));
        t.clock.set(new Date(Date.parse(`${D}T02:30:00.000Z`)));

        await reconcile(); // the window covers 2026-10-02, -03, -04
        expect(await runs(campaign.id)).toEqual([]);

        await reconcile(old);
        const [run] = await runs(campaign.id);
        expect(run).toMatchObject({
          source: 'reconciliation',
          amountMinor: '100',
          clicks: 4,
        });
      });
    });

    it('S36 AS-63: two reconciliations of one day started at once do the work once', async () => {
      const campaign = await newCampaign(25, 100_000);
      await streamBilled(campaign.id, H, 12);
      await insertRaw(validClicks(campaign.id, H, 10));
      t.clock.set(nextMorning());

      const results = await inParallel(2, () => reconcile(D));

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await adjustments(campaign.id)).toHaveLength(1);
      expect(await journals(`ad-adj:${campaign.id}:${H}:1`)).toHaveLength(1);
      expect(await net(campaign.id, H)).toBe(250);
      expect(await shopBalance()).toBe(-250);
    });

    it('S36 AS-64: a raw log that cannot be read records a FAILED run, moves no money, and the next run processes the day', async () => {
      const campaign = await newCampaign(25, 100_000);
      await streamBilled(campaign.id, H, 12);
      await insertRaw(validClicks(campaign.id, H, 10));
      t.clock.set(nextMorning());
      const failed =
        MetricsRegistry.value('ads_reconciliation_runs_total', {
          status: 'failed',
        }) ?? 0;
      t.faults.set('raw', { kind: 'down' });

      await expect(reconcile(D)).resolves.not.toThrow();

      expect(await reconRuns()).toEqual([
        expect.objectContaining({
          status: 'FAILED',
          reason: 'source_unavailable',
        }),
      ]);
      expect(await adjustments(campaign.id)).toEqual([]);
      expect(await shopBalance()).toBe(-300);
      expect(
        MetricsRegistry.value('ads_reconciliation_runs_total', {
          status: 'failed',
        }),
      ).toBe(failed + 1);

      t.faults.clear();
      await reconcile(D);
      expect((await reconRuns()).map((r) => r.status)).toEqual([
        'FAILED',
        'COMPLETED',
      ]);
      expect(await shopBalance()).toBe(-250);
    });

    describe('S36 AS-65: drift above 1% is visible', () => {
      const warnings = () =>
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
      afterEach(() => {
        jest.restoreAllMocks();
      });

      it.each([
        ['5%', 105, true],
        ['1% exactly', 101, false],
        ['no drift', 100, false],
      ])(
        'billed %s apart from exact: warning is %s',
        async (_name, billed, warns) => {
          const campaign = await newCampaign(25, 10_000_000);
          await streamBilled(campaign.id, H, billed);
          await insertRaw(validClicks(campaign.id, H, 100));
          t.clock.set(nextMorning());
          const warn = warnings();

          await reconcile(D);

          const ratio = Math.abs(100 - billed) / 100;
          expect(
            MetricsRegistry.value('ads_reconciliation_drift_ratio', { day: D }),
          ).toBeCloseTo(ratio, 6);
          const messages = warn.mock.calls.map((c) => String(c[0]));
          expect(messages.some((m) => m.includes(D) && /drift/i.test(m))).toBe(
            warns,
          );
        },
      );
    });

    describe('the advertiser’s statement', () => {
      const iso = (hour: string, minutes = 0) =>
        at(hour, minutes).toISOString();
      const statement = (
        user: { bearer: string },
        campaignId: string,
        query = '',
        shopId = team.shop.id,
      ) =>
        t
          .http()
          .get(
            `/api/shops/${shopId}/ads/campaigns/${campaignId}/billing${query}`,
          )
          .set('Authorization', user.bearer);
      const problemCode = (res: { body: { code: string } }) => res.body.code;
      /** The clock moved into the past of the sessions: the members sign in again, as they would. */
      const signInAgain = (...users: Parameters<typeof t.reauth>[0][]) =>
        Promise.all(users.map((u) => t.reauth(u)));
      const range = `from=${encodeURIComponent(iso(H, -60))}&to=${encodeURIComponent(iso(plusHours(H, 6)))}`;

      it('S36 AS-68: lists each billed hour newest first with its adjustments and net, keyset-paged; roles, tenant, range and cursor errors', async () => {
        const campaign = await newCampaign(25, 100_000);
        const hours = Array.from({ length: 5 }, (_, i) => plusHours(H, i));
        for (const [i, hour] of hours.entries())
          await seedRun(campaign.id, hour, {
            clicks: 4 + i,
            amountMinor: (4 + i) * 25,
          });
        const adjusted = at(hours[2]);
        await t.sql(
          `INSERT INTO "AdBillingAdjustment" ("campaignId", "hour", "sequence", "deltaClicks", "deltaMinor", "ledgerReference", "state", "postedAt")
           VALUES (:id, :hour, 1, -2, -50, :r1, 'POSTED', :at), (:id, :hour, 2, 1, 25, :r2, 'PENDING', NULL) RETURNING 1`,
          {
            id: campaign.id,
            hour: adjusted,
            r1: `ad-adj:${campaign.id}:${hours[2]}:1`,
            r2: `ad-adj:${campaign.id}:${hours[2]}:2`,
            at: at(hours[4], 90),
          },
        );
        t.clock.set(at(hours[4], 120));
        const other = await t.team();
        await signInAgain(
          team.owner,
          team.admin,
          team.staff,
          team.viewer,
          other.owner,
        );

        const seen: string[] = [];
        let cursor: string | null = null;
        let items: AdBillingItem[] = [];
        do {
          const res = await statement(
            team.owner,
            campaign.id,
            `?${range}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          );
          expect(res.status).toBe(200);
          const page = adBillingPageSchema.parse(res.body);
          items = [...items, ...page.items];
          seen.push(...page.items.map((i) => i.hour.slice(0, 13)));
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen).toEqual([...hours].reverse());

        const byHour = (h: string) => items.find((i) => i.hour.startsWith(h))!;
        expect(byHour(hours[0])).toMatchObject({
          state: 'CHARGED',
          source: 'stream',
          clicks: 4,
          billableClicks: 4,
          cappedClicks: 0,
          amountMinor: 100,
          adjustments: [],
          netAmountMinor: 100,
        });
        expect(byHour(hours[2])).toMatchObject({
          amountMinor: 150,
          netAmountMinor: 100,
        }); // only the posted adjustment is in the net
        expect(byHour(hours[2]).adjustments).toEqual([
          {
            sequence: 1,
            deltaClicks: -2,
            deltaMinor: -50,
            postedAt: iso(hours[4], 90),
          },
          { sequence: 2, deltaClicks: 1, deltaMinor: 25, postedAt: null },
        ]);

        // roles: payouts.read is for owners and admins
        for (const user of [team.viewer, team.staff]) {
          const denied = await statement(user, campaign.id, `?${range}`);
          expect(denied.status).toBe(403);
          expect(problemCode(denied)).toBe('permission_denied');
        }
        expect(
          (await statement(team.admin, campaign.id, `?${range}`)).status,
        ).toBe(200);
        expect(
          (
            await t
              .http()
              .get(
                `/api/shops/${team.shop.id}/ads/campaigns/${campaign.id}/billing`,
              )
          ).status,
        ).toBe(401);

        // tenant: another shop's campaign is 404, like an unknown one
        const foreign = await statement(
          other.owner,
          campaign.id,
          `?${range}`,
          other.shop.id,
        );
        expect(foreign.status).toBe(404);
        expect(problemCode(foreign)).toBe('campaign_not_found');
        expect(
          problemCode(await statement(team.owner, uuidv4(), `?${range}`)),
        ).toBe('campaign_not_found');

        // errors: a range the wrong way round, over 92 days, a bad limit and a tampered cursor
        const backwards = await statement(
          team.owner,
          campaign.id,
          `?from=${encodeURIComponent(iso(H, 60))}&to=${encodeURIComponent(iso(H))}`,
        );
        expect([backwards.status, problemCode(backwards)]).toEqual([
          400,
          'validation_failed',
        ]);
        const tooLong = await statement(
          team.owner,
          campaign.id,
          `?from=${encodeURIComponent('2026-01-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-06-01T00:00:00.000Z')}`,
        );
        expect([tooLong.status, problemCode(tooLong)]).toEqual([
          400,
          'validation_failed',
        ]);
        const badLimit = await statement(
          team.owner,
          campaign.id,
          `?${range}&limit=0`,
        );
        expect([badLimit.status, problemCode(badLimit)]).toEqual([
          400,
          'validation_failed',
        ]);
        const tampered = await statement(
          team.owner,
          campaign.id,
          `?${range}&cursor=abc.def`,
        );
        expect([tampered.status, problemCode(tampered)]).toEqual([
          400,
          'invalid_cursor',
        ]);
      });

      it('S36 AS-03: the statement needs payouts.read: a viewer and a staff member are refused, an admin reads it', async () => {
        const campaign = await newCampaign();
        for (const user of [team.viewer, team.staff])
          expect((await statement(user, campaign.id)).status).toBe(403);
        expect((await statement(team.admin, campaign.id)).status).toBe(200);
        expect((await statement(team.owner, campaign.id)).status).toBe(200);
      });

      it('S36 AS-69: the statement’s net amounts add up to the movement of the shop’s ledger account for the campaign’s references', async () => {
        const campaign = await newCampaign(25, 100_000);
        await streamBilled(campaign.id, H, 12);
        await streamBilled(campaign.id, plusHours(H, 1), 8);
        await insertRaw(validClicks(campaign.id, H, 10));
        await insertRaw(validClicks(campaign.id, plusHours(H, 1), 9));
        t.clock.set(nextMorning());
        await reconcile(D);
        await signInAgain(team.owner);

        const res = await statement(
          team.owner,
          campaign.id,
          `?${range}&limit=100`,
        );
        const page = adBillingPageSchema.parse(res.body);
        expect(page.items).toHaveLength(2);
        const [moved] = await t.sql<{ total: string }>(
          `SELECT COALESCE(SUM(e."amount"), 0) AS "total" FROM "LedgerEntry" e
             JOIN "LedgerJournal" j ON j."id" = e."journalId"
            WHERE e."accountId" = :account AND (j."reference" LIKE :charges OR j."reference" LIKE :adjustments)`,
          {
            account: shopAccount(team.shop.id),
            charges: `ad:${campaign.id}:%`,
            adjustments: `ad-adj:${campaign.id}:%`,
          },
        );
        const netTotal = page.items.reduce(
          (sum, i) => sum + i.netAmountMinor,
          0,
        );
        expect(netTotal).toBe(250 + 225);
        expect(Math.abs(Number(moved.total))).toBe(netTotal);
        expect(await shopBalance()).toBe(-netTotal);
      });
    });

    it('S36 AS-66: only valid distinct clicks received within the UTC day count; the boundary belongs to the day it falls in', async () => {
      const campaign = await newCampaign(25, 100_000);
      const next = '2026-10-06';
      const dup = '00000000-0000-4000-8000-0000000000aa';
      await insertRaw([
        raw(campaign.id, stamp(D, '23:59:59.999')), // the last millisecond of D
        raw(campaign.id, stamp(next, '00:00:00.000')), // the first of D+1
        raw(campaign.id, stamp(D, '12:00:00.000'), { valid: 0 }), // invalid
        raw(campaign.id, stamp(D, '12:05:00.000'), { clickId: dup }),
        raw(campaign.id, stamp(D, '12:06:00.000'), { clickId: dup }), // a duplicate click id
      ]);
      t.clock.set(new Date(Date.parse(`${next}T02:30:00.000Z`) + 86_400_000));

      await reconcile(D);
      await reconcile(next);

      const rows = await runs(campaign.id);
      expect(
        rows.map((r) => [r.hour.toISOString().slice(0, 13), r.clicks]),
      ).toEqual([
        [`${D}T12`, 1],
        [`${D}T23`, 1],
        [`${next}T00`, 1],
      ]);
    });
  });
});

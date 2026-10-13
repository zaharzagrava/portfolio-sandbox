import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { NonRetryableJobError } from '@app/infrastructure/jobs';
import {
  BILLING_STORE,
  CAMPAIGN_STORE,
  RAW_CLICK_READER,
  LEDGER_PORT,
  type AdjustmentRecord,
  type BillingStore,
  type CampaignRecord,
  type CampaignStore,
  type ExactHourClicks,
  type LedgerPort,
  type RawClickReader,
} from '../domain/ads-ports';
import {
  DAY_MS,
  DRIFT_WARN_RATIO,
  RECONCILE_STALE_MS,
  RECONCILE_WINDOW_DAYS,
} from '../domain/ads-constants';
import {
  adsBillingAdjustmentCounter,
  adsBillingOrphanCounter,
  adsReconciliationDriftGauge,
  adsReconciliationRunsCounter,
} from '../domain/ads-metrics';
import { adjust, exactDay, nextSequence } from '../domain/adjustment-math';
import {
  adjustmentReference,
  chargeReference,
  dayKey,
  dayStart,
  hourStart,
} from '../domain/click-record';
import { HourlyBillingService } from './hourly-billing.service';

export interface ReconciliationDayResult {
  day: string;
  outcome: 'completed' | 'failed' | 'skipped';
  hoursChecked: number;
  hoursAdjusted: number;
  netDeltaMinor: number;
  driftRatio: number | null;
}

const CAMPAIGN_BATCH = 500;

/**
 * Daily reconciliation and period close (US7, P0614, FR-050 to FR-056). The batch path is the source of truth: for each
 * campaign-hour of each of the last 3 closed UTC days (or one explicit day) the exact billable clicks are recomputed from
 * the raw log (first recorded verdict per click id, valid, received within the day), the daily cap is applied to the exact
 * clicks in hour order, and the difference with what was net billed is posted as a numbered `ADJUSTMENT` dated NOW. A closed
 * day is never rewritten: its runs, charge journals and earlier adjustments are only read; a later correction is a new row.
 * One reconciliation per day at a time (the loser is skipped); an unreadable raw log records `FAILED` and moves no money.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(CAMPAIGN_STORE) private readonly campaigns: CampaignStore,
    @Inject(BILLING_STORE) private readonly billing: BillingStore,
    @Inject(RAW_CLICK_READER) private readonly raw: RawClickReader,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly hourly: HourlyBillingService,
  ) {}

  /** No `day`: the last three closed days, oldest first. An explicit day is processed whatever its age, once it is closed. */
  async reconcile(day?: string): Promise<ReconciliationDayResult[]> {
    const now = this.clock.now();
    const today = dayKey(now);
    if (day !== undefined && !(day < today))
      throw new NonRetryableJobError('day_not_closed');
    const days =
      day !== undefined
        ? [day]
        : Array.from({ length: RECONCILE_WINDOW_DAYS }, (_, i) =>
            dayKey(
              new Date(
                dayStart(today).getTime() -
                  (RECONCILE_WINDOW_DAYS - i) * DAY_MS,
              ),
            ),
          );
    const results: ReconciliationDayResult[] = [];
    for (const d of days) results.push(await this.reconcileDay(d, now));
    return results;
  }

  private async reconcileDay(
    day: string,
    now: Date,
  ): Promise<ReconciliationDayResult> {
    const empty = {
      day,
      hoursChecked: 0,
      hoursAdjusted: 0,
      netDeltaMinor: 0,
      driftRatio: null,
    };
    await this.billing.abandonStaleReconciliations(
      day,
      new Date(now.getTime() - RECONCILE_STALE_MS),
    );
    const run = await this.billing.startReconciliation(day, now);
    if (!run) {
      this.logger.log(`reconciliation of ${day} is already running; skipped`);
      return { ...empty, outcome: 'skipped' };
    }

    let exact: ExactHourClicks[];
    try {
      exact = await this.raw.exactValidClicksByHour(day);
    } catch {
      await this.billing.finishReconciliation(
        run.id,
        { status: 'FAILED', reason: 'source_unavailable' },
        now,
      );
      adsReconciliationRunsCounter.add(1, { status: 'failed' });
      this.logger.warn(
        `reconciliation of ${day} failed: the raw click log is unavailable`,
      );
      return { ...empty, outcome: 'failed' };
    }

    try {
      const summary = await this.apply(day, exact, run.id, now);
      await this.billing.finishReconciliation(
        run.id,
        { status: 'COMPLETED', ...summary },
        now,
      );
      adsReconciliationRunsCounter.add(1, { status: 'completed' });
      return { day, outcome: 'completed', ...summary };
    } catch (error) {
      // the ledger was busy or a store failed: the day stays unfinished and the job is retried; nothing is half-closed
      await this.billing
        .finishReconciliation(
          run.id,
          { status: 'FAILED', reason: 'error' },
          now,
        )
        .catch(() => undefined);
      adsReconciliationRunsCounter.add(1, { status: 'failed' });
      throw error;
    }
  }

  private async apply(
    day: string,
    exact: ExactHourClicks[],
    runId: string,
    now: Date,
  ): Promise<Omit<ReconciliationDayResult, 'day' | 'outcome'>> {
    const start = dayStart(day);
    const exactByCampaign = new Map<string, Map<string, number>>();
    for (const row of exact) {
      const hours =
        exactByCampaign.get(row.campaignId) ?? new Map<string, number>();
      hours.set(row.hour, (hours.get(row.hour) ?? 0) + row.clicks);
      exactByCampaign.set(row.campaignId, hours);
    }
    const ids = [
      ...new Set([
        ...exactByCampaign.keys(),
        ...(await this.billing.campaignIdsWithRuns(start)),
      ]),
    ].sort();
    const campaigns = new Map<string, CampaignRecord>();
    for (let i = 0; i < ids.length; i += CAMPAIGN_BATCH)
      for (const c of await this.campaigns.findManyByIds(
        ids.slice(i, i + CAMPAIGN_BATCH),
      ))
        campaigns.set(c.id, c);

    let hoursChecked = 0;
    let hoursAdjusted = 0;
    let netDeltaMinor = 0;
    let exactClicks = 0;
    let billedClicks = 0;

    for (const id of ids) {
      const campaign = campaigns.get(id);
      if (!campaign) {
        adsBillingOrphanCounter.add(1);
        continue;
      }
      const runs = new Map(
        (await this.billing.runsOfDay(id, start)).map((r) => [
          r.hour.toISOString().slice(0, 13),
          r,
        ]),
      );
      const exactHours = exactByCampaign.get(id) ?? new Map<string, number>();
      const hours = [...new Set([...exactHours.keys(), ...runs.keys()])];
      const plan = exactDay(
        hours.map((hour) => ({ hour, clicks: exactHours.get(hour) ?? 0 })),
        campaign.cpcMinor,
        campaign.dailyBudgetMinor,
      );

      for (const target of plan) {
        hoursChecked++;
        const hourDate = hourStart(target.hour);
        const exactForHour = exactHours.get(target.hour) ?? 0;
        exactClicks += exactForHour;
        let run = runs.get(target.hour);
        if (run) billedClicks += run.clicks;

        if (!run) {
          // an hour the stream path missed entirely: charged with the reference the hourly job would use (AS-60)
          if (target.amountMinor === 0) {
            billedClicks += exactForHour;
            continue;
          }
          await this.billing.insertRun(
            {
              campaignId: id,
              hour: hourDate,
              state: 'PENDING',
              source: 'reconciliation',
              clicks: exactForHour,
              billableClicks: target.billableClicks,
              cappedClicks: target.cappedClicks,
              amountMinor: target.amountMinor,
              ledgerReference: chargeReference(id, hourDate),
            },
            now,
          );
          run = (await this.billing.findRun(id, hourDate)) ?? undefined;
          if (!run) continue;
          billedClicks += run.clicks;
          hoursAdjusted++;
          netDeltaMinor += run.amountMinor;
        }
        if (run.state === 'PENDING')
          await this.hourly.chargeRun(campaign, run, now);

        const existing = await this.billing.adjustmentsOf(id, hourDate);
        for (const pending of existing.filter((a) => a.state === 'PENDING'))
          await this.postAdjustment(campaign, pending, now);
        const net =
          run.amountMinor + existing.reduce((sum, a) => sum + a.deltaMinor, 0);
        const netClicks =
          run.billableClicks +
          existing.reduce((sum, a) => sum + a.deltaClicks, 0);
        const { deltaMinor } = adjust(target.amountMinor, net);
        if (deltaMinor === 0) continue;

        const sequence = nextSequence(existing.map((a) => a.sequence));
        const adjustment = {
          campaignId: id,
          hour: hourDate,
          sequence,
          deltaClicks: target.billableClicks - netClicks,
          deltaMinor,
          ledgerReference: adjustmentReference(id, hourDate, sequence),
          reconciliationRunId: runId,
        };
        // a lost race on (campaign, hour, sequence) means another pass already decided this correction
        if (!(await this.billing.insertAdjustment(adjustment, now))) continue;
        await this.postAdjustment(campaign, adjustment, now);
        hoursAdjusted++;
        netDeltaMinor += deltaMinor;
      }
    }

    const driftRatio =
      exactClicks === 0
        ? billedClicks > 0
          ? 1
          : 0
        : Math.abs(exactClicks - billedClicks) / exactClicks;
    adsReconciliationDriftGauge.set(driftRatio, { day });
    if (driftRatio > DRIFT_WARN_RATIO)
      this.logger.warn(
        `reconciliation drift above 1% for ${day}: ratio ${driftRatio.toFixed(4)}, exact clicks ${exactClicks}, billed clicks ${billedClicks}`,
      );
    return { hoursChecked, hoursAdjusted, netDeltaMinor, driftRatio };
  }

  /** The ledger posting, then `PENDING -> POSTED` dated now: a correction belongs to the period it is posted in. */
  private async postAdjustment(
    campaign: CampaignRecord,
    adjustment: Pick<
      AdjustmentRecord,
      'campaignId' | 'hour' | 'sequence' | 'deltaMinor' | 'ledgerReference'
    >,
    now: Date,
  ): Promise<void> {
    const posted = await this.ledger.post({
      kind: 'ADJUSTMENT',
      reference: adjustment.ledgerReference,
      shopId: campaign.shopId,
      chargeMinor: adjustment.deltaMinor,
    });
    const marked = await this.billing.markAdjustmentPosted(
      adjustment.campaignId,
      adjustment.hour,
      adjustment.sequence,
      posted.journalId,
      now,
    );
    if (marked)
      adsBillingAdjustmentCounter.add(Math.abs(adjustment.deltaMinor), {
        direction: adjustment.deltaMinor > 0 ? 'charge' : 'refund',
      });
  }
}

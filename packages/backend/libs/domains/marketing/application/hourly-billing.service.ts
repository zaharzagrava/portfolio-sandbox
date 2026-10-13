import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { NonRetryableJobError } from '@app/infrastructure/jobs';
import {
  AGGREGATE_READER,
  BILLING_STORE,
  CAMPAIGN_STORE,
  LEDGER_PORT,
  type AggregateReader,
  type BillingStore,
  type BillingRunRecord,
  type CampaignRecord,
  type CampaignStore,
  type LedgerPort,
} from '../domain/ads-ports';
import { HOUR_CLOSE_GRACE_MS, HOUR_MS } from '../domain/ads-constants';
import {
  adsBillingChargedCounter,
  adsBillingLagGauge,
  adsBillingOrphanCounter,
} from '../domain/ads-metrics';
import { billable } from '../domain/billing-math';
import {
  chargeReference,
  dayKey,
  dayStart,
  hourKey,
  hourStart,
} from '../domain/click-record';

export interface HourlyBillingResult {
  hour: string;
  campaigns: number;
  chargedMinor: number;
}

const CAMPAIGN_BATCH = 500;

/**
 * The hourly charge (US6, FR-040 to FR-046). For the last closed UTC hour, each campaign's committed aggregates become one
 * billing run `(campaign, hour)` and one `AD_CHARGE` journal, in three separate units of work, none of which touches
 * both owners (IX.4): (A) the marketing run row `PENDING`, its amounts frozen, (B) the ledger-only posting under the
 * stable reference `ad:<campaign>:<hour>`, (C) the marketing row `PENDING -> CHARGED`. A retry, an overlapping run or a
 * crash between the steps converges: the run is unique per hour, the ledger answers `created: false` for a reference it
 * already holds, and a pending run is finished with the amounts it first decided, never recomputed. Whole clicks only,
 * capped by the day's budget (`billable`). Time comes from the injected clock.
 */
@Injectable()
export class HourlyBillingService {
  private readonly logger = new Logger(HourlyBillingService.name);

  constructor(
    @Inject(CAMPAIGN_STORE) private readonly campaigns: CampaignStore,
    @Inject(BILLING_STORE) private readonly billing: BillingStore,
    @Inject(AGGREGATE_READER) private readonly aggregates: AggregateReader,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `hour` is `YYYY-MM-DDTHH`; without it the last closed hour is billed, never the open one (AS-56). */
  async billHour(hour?: string): Promise<HourlyBillingResult> {
    const now = this.clock.now();
    const start = hour ? this.closedHour(hour, now) : this.lastClosedHour(now);
    const key = hourKey(start);

    const aggregated = await this.aggregates.clicksByCampaign(key);
    const campaigns = new Map<string, CampaignRecord>();
    for (let i = 0; i < aggregated.length; i += CAMPAIGN_BATCH)
      for (const c of await this.campaigns.findManyByIds(
        aggregated.slice(i, i + CAMPAIGN_BATCH).map((a) => a.campaignId),
      ))
        campaigns.set(c.id, c);

    let chargedMinor = 0;
    for (const { campaignId, clicks } of aggregated) {
      const campaign = campaigns.get(campaignId);
      if (!campaign) {
        adsBillingOrphanCounter.add(1);
        this.logger.warn(
          `aggregate of an unknown campaign skipped (hour ${key})`,
        );
        continue;
      }
      chargedMinor += await this.billCampaign(campaign, clicks, start, now);
    }
    adsBillingLagGauge.set(
      (now.getTime() - (start.getTime() + HOUR_MS)) / 1000,
    );
    return { hour: key, campaigns: aggregated.length, chargedMinor };
  }

  private async billCampaign(
    campaign: CampaignRecord,
    clicks: number,
    hour: Date,
    now: Date,
  ): Promise<number> {
    let run = await this.billing.findRun(campaign.id, hour);
    if (!run) {
      // (A) decide and freeze: what was billed earlier today is the net of this campaign's earlier hours
      const earlier = await this.billing.netBilledBefore(
        campaign.id,
        dayStart(dayKey(hour)),
        hour,
      );
      const result = billable(
        clicks,
        campaign.cpcMinor,
        campaign.dailyBudgetMinor,
        earlier,
      );
      await this.billing.insertRun(
        {
          campaignId: campaign.id,
          hour,
          // nothing to post for a zero amount: the run is complete at once
          state: result.amountMinor > 0 ? 'PENDING' : 'CHARGED',
          source: 'stream',
          clicks,
          ...result,
          ledgerReference: chargeReference(campaign.id, hour),
        },
        now,
      );
      // whoever inserted first decided; a racing run continues with that row
      run = (await this.billing.findRun(campaign.id, hour)) as BillingRunRecord;
    }
    if (run.state === 'CHARGED') return 0;
    return this.chargeRun(campaign, run, now);
  }

  /**
   * (B) the ledger-only posting, then (C) the conditional `PENDING -> CHARGED`. Also used by the reconciliation to finish
   * a run that is still pending or that it created for an hour the stream path missed.
   */
  async chargeRun(
    campaign: CampaignRecord,
    run: BillingRunRecord,
    now: Date,
  ): Promise<number> {
    const posted = await this.ledger.post({
      kind: 'AD_CHARGE',
      reference: run.ledgerReference,
      shopId: campaign.shopId,
      chargeMinor: run.amountMinor,
    });
    const marked = await this.billing.markCharged(
      run.campaignId,
      run.hour,
      posted.journalId,
      now,
    );
    if (!marked) return 0; // another run finished it
    adsBillingChargedCounter.add(run.amountMinor);
    return run.amountMinor;
  }

  /** FR-040: an explicit hour must have ended at least 5 minutes ago, so its aggregates are complete. */
  private closedHour(hour: string, now: Date): Date {
    const start = hourStart(hour);
    if (Number.isNaN(start.getTime()))
      throw new NonRetryableJobError('invalid hour');
    if (now.getTime() < start.getTime() + HOUR_MS + HOUR_CLOSE_GRACE_MS)
      throw new NonRetryableJobError('hour_not_closed');
    return start;
  }

  private lastClosedHour(now: Date): Date {
    const closed =
      Math.floor((now.getTime() - HOUR_CLOSE_GRACE_MS) / HOUR_MS) * HOUR_MS;
    return new Date(closed - HOUR_MS);
  }
}

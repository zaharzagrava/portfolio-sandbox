import { Inject, Injectable } from '@nestjs/common';
import {
  AD_STATEMENT_MAX_DAYS,
  type AdBillingItem,
  type AdBillingPage,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  BILLING_STORE,
  type BillingStore,
  type StatementRow,
} from '../domain/ads-ports';
import { DAY_MS } from '../domain/ads-constants';
import { decodeCursor, encodeCursor } from '../domain/ads-cursor';
import { validationFailed } from '../domain/ads-errors';
import { CampaignQueryService } from './campaign-query.service';

const DEFAULT_RANGE_DAYS = 7;

export interface StatementQuery {
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

const toItem = ({ run, adjustments }: StatementRow): AdBillingItem => ({
  hour: run.hour.toISOString(),
  state: run.state,
  source: run.source,
  clicks: run.clicks,
  billableClicks: run.billableClicks,
  cappedClicks: run.cappedClicks,
  amountMinor: run.amountMinor,
  adjustments: adjustments.map((a) => ({
    sequence: a.sequence,
    deltaClicks: a.deltaClicks,
    deltaMinor: a.deltaMinor,
    postedAt: a.postedAt?.toISOString() ?? null,
  })),
  // only posted adjustments have moved money
  netAmountMinor:
    run.amountMinor +
    adjustments
      .filter((a) => a.state === 'POSTED')
      .reduce((sum, a) => sum + a.deltaMinor, 0),
});

/**
 * The advertiser's statement (US8, FR-058): every billed hour of one campaign with its state, source, clicks, billable and
 * capped clicks, amount, adjustments and net amount, newest hour first, keyset-paged by a signed cursor bound to the
 * campaign. The campaign is first loaded with the shop in the predicate, so another shop's id is `404`. The net amount
 * of the rows equals the movement of the shop's ledger account for the campaign's references (AS-69).
 */
@Injectable()
export class BillingStatementService {
  constructor(
    @Inject(BILLING_STORE) private readonly billing: BillingStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly campaigns: CampaignQueryService,
    private readonly config: ApiConfigService,
  ) {}

  async statement(
    shopId: string,
    campaignId: string,
    query: StatementQuery,
  ): Promise<AdBillingPage> {
    const campaign = await this.campaigns.find(shopId, campaignId);
    const to = query.to ? new Date(query.to) : this.clock.now();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
    if (!(from.getTime() < to.getTime())) throw validationFailed(['from']);
    if (to.getTime() - from.getTime() > AD_STATEMENT_MAX_DAYS * DAY_MS)
      throw validationFailed(['from', 'to']);

    const key = this.config.get('jwt_secret');
    const before = query.cursor
      ? new Date(decodeCursor(key, campaign.id, query.cursor).h)
      : undefined;
    const rows = await this.billing.statement(campaign.id, {
      from,
      to,
      limit: query.limit + 1,
      before,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toItem),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(key, campaign.id, { h: last.run.hour.toISOString() })
          : null,
    };
  }
}

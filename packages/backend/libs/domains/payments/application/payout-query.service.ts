import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminPayoutView,
  PayoutDetailView,
  PayoutRunView,
  PayoutView,
  UpcomingPayoutView,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { blockedReason } from '../domain/eligibility';
import { PayoutNotFound } from '../domain/payout-errors';
import {
  decodePayoutCursor,
  encodePayoutCursor,
} from '../domain/payout-cursor';
import {
  PAYOUT_DESTINATION_REPOSITORY,
  PAYOUT_LEDGER,
  PAYOUT_REPOSITORY,
  PAYOUT_RESERVE_REPOSITORY,
  PAYOUT_RUN_REPOSITORY,
  SHOP_SUMMARY_PORT,
  type AdminListFilter,
  type PayoutDestinationRepository,
  type PayoutLedgerPort,
  type PayoutRepository,
  type PayoutReserveRepository,
  type PayoutRunRepository,
  type ShopSummaryPort,
} from '../domain/payout-ports';
import { toPublicStatus, type PayoutStatus } from '../domain/payout-state';
import { nextRunAt } from '../domain/period';
import { computeReserve, planPayout } from '../domain/reserve';
import { ledgerCursorSecret } from './cursor-secret';
import { PAYOUT_CURRENCY } from './payout-creation.service';
import { toAdminPayoutView, toPayoutView } from './payout-views';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Reads of the payouts (S15 FR-031…FR-037, FR-046): the seller's keyset list, one payout with its timeline, the
 * upcoming payout (computed with the SAME pure functions as the run) and the operator's list and run records. Every
 * body is built field by field; the principal is part of the predicate (a payout of another shop is "not found").
 */
@Injectable()
export class PayoutQueryService {
  constructor(
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: PayoutRepository,
    @Inject(PAYOUT_RUN_REPOSITORY) private readonly runs: PayoutRunRepository,
    @Inject(PAYOUT_LEDGER) private readonly ledger: PayoutLedgerPort,
    @Inject(SHOP_SUMMARY_PORT) private readonly shops: ShopSummaryPort,
    @Inject(PAYOUT_DESTINATION_REPOSITORY)
    private readonly destinations: PayoutDestinationRepository,
    @Inject(PAYOUT_RESERVE_REPOSITORY)
    private readonly reserves: PayoutReserveRepository,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private secret(): string {
    return (
      this.config.get('payout_cursor_secret') || ledgerCursorSecret(this.config)
    );
  }

  async listForShop(
    shopId: string,
    query: { limit: number; cursor?: string },
  ): Promise<Page<PayoutView>> {
    const after = query.cursor
      ? decodePayoutCursor(query.cursor, 'seller', this.secret())
      : undefined;
    const rows = await this.payouts.listForShop(shopId, {
      limit: query.limit + 1,
      after: after && { k: after.k, id: after.id! },
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toPayoutView),
      nextCursor:
        rows.length > query.limit && last
          ? encodePayoutCursor(
              { r: 'seller', k: last.periodStart, id: last.id },
              this.secret(),
            )
          : null,
    };
  }

  async getForShop(
    shopId: string,
    payoutId: string,
  ): Promise<PayoutDetailView> {
    const payout = await this.payouts.findForShop(payoutId, shopId);
    if (!payout) throw new PayoutNotFound();
    const history = await this.payouts.timeline(payout.id);
    const timeline: PayoutDetailView['timeline'] = [];
    for (const row of history) {
      const status = toPublicStatus(row.toStatus as PayoutStatus);
      if (timeline[timeline.length - 1]?.status === status) continue;
      timeline.push({ status, at: row.at.toISOString() });
    }
    return { ...toPayoutView(payout), timeline };
  }

  async upcoming(shopId: string): Promise<UpcomingPayoutView> {
    const now = this.clock.now();
    const [balances, summaries, destination, reserve] = await Promise.all([
      this.ledger.balances([shopId], PAYOUT_CURRENCY),
      this.shops.getSummaries([shopId]),
      this.destinations.find(shopId),
      this.reserves.find(shopId),
    ]);
    const available = balances.get(shopId) ?? 0;
    const bps =
      reserve?.reserveBps ?? this.config.get('payout_default_reserve_bps');
    const plan = planPayout(available, bps, {
      minMinor: this.config.get('payout_min_minor'),
      capMinor: this.config.get('payout_cap_minor'),
    });
    const summary = summaries.get(shopId);
    const blocked = blockedReason(
      {
        known: summary !== undefined,
        status: summary?.status,
        payoutsEnabled: summary?.payoutsEnabled ?? false,
        destination,
        now,
      },
      plan,
    );
    const reserveMinor =
      available > 0
        ? plan.kind === 'pay'
          ? plan.reserveHeldMinor
          : computeReserve(available, bps).reserveMinor
        : 0;
    return {
      shopId,
      currency: 'EUR',
      availableMinor: available,
      reserveMinor,
      estimatedPayoutMinor:
        blocked === null && plan.kind === 'pay' ? plan.amountMinor : 0,
      nextRunAt: nextRunAt(now).toISOString(),
      blockedReason: blocked,
    };
  }

  async listAll(query: {
    limit: number;
    cursor?: string;
    status?: PayoutStatus;
    shopId?: string;
    periodStart?: string;
  }): Promise<Page<AdminPayoutView>> {
    const after = query.cursor
      ? decodePayoutCursor(query.cursor, 'admin', this.secret())
      : undefined;
    const filter: AdminListFilter = {
      status: query.status,
      shopId: query.shopId,
      periodStart: query.periodStart,
    };
    const rows = await this.payouts.listAll(filter, {
      limit: query.limit + 1,
      after: after && { k: after.k, id: after.id! },
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toAdminPayoutView),
      nextCursor:
        rows.length > query.limit && last
          ? encodePayoutCursor(
              { r: 'admin', k: last.createdAtKey, id: last.id },
              this.secret(),
            )
          : null,
    };
  }

  async listRuns(query: {
    limit: number;
    cursor?: string;
  }): Promise<Page<PayoutRunView>> {
    const after = query.cursor
      ? decodePayoutCursor(query.cursor, 'runs', this.secret())
      : undefined;
    const rows = await this.runs.list({
      limit: query.limit + 1,
      after: after?.k,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        periodStart: r.periodStart,
        status: r.status,
        created: r.created,
        existing: r.existing,
        skipped: r.skipped,
        failureCode: r.failureCode,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodePayoutCursor(
              { r: 'runs', k: last.periodStart },
              this.secret(),
            )
          : null,
    };
  }
}

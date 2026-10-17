import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type {
  SellerOverviewError,
  SellerOverviewResponse,
} from '@marketplace-sandbox/contracts';
import { BffSettings } from '../bff-config';
import { tokenOf, type Credentials } from '../credentials/credentials';
import { requiredFailureProblem } from '../page/required-failure';
import { BffProblem } from '../problem';
import {
  shopById,
  shopDashboardToday,
  shopRank,
  shopStats,
} from '../upstream/endpoints/seller';
import type { Endpoint } from '../upstream/endpoints/endpoint';
import { UpstreamClient } from '../upstream/upstream-client';
import { classify, type UpstreamFailure } from '../upstream/upstream-error';

type Section = SellerOverviewError['section'];
type Outcome<T> =
  | { ok: true; body: T }
  | { ok: false; failure: UpstreamFailure };

/**
 * W04 B-1: the shop (read first, as the caller, so a non-member learns nothing) plus stats, today and rank in parallel.
 * Each section has its own budget; a failed one is `null` with an `errors[]` entry. An upstream `404 not_ranked` is a
 * normal answer (`{notRanked: true}`), not an error. No database access, no business rule, nothing cached.
 */
@Injectable()
export class SellerOverviewService {
  constructor(
    private readonly upstream: UpstreamClient,
    private readonly settings: BffSettings,
  ) {}

  async load(args: {
    shopId: string;
    days: number;
    credentials: Credentials;
    signal?: AbortSignal;
  }): Promise<SellerOverviewResponse> {
    if (!tokenOf(args.credentials)) throw new BffProblem('unauthenticated');
    const deadlineAt = performance.now() + this.settings.pageDeadlineMs;
    const slots = this.upstream.gate.forRequest();
    const controller = new AbortController();
    args.signal?.addEventListener('abort', () => controller.abort(), {
      once: true,
    });
    const ctx = (own: number) => {
      const left = deadlineAt - performance.now();
      return {
        credentials: args.credentials,
        slots,
        signal: controller.signal,
        budgetMs: Math.min(own, left),
        deadlineLimited: left <= own,
      };
    };
    const attempt = <T>(
      endpoint: Endpoint<T>,
      budgetMs: number,
    ): Promise<Outcome<T>> =>
      this.upstream.call(endpoint, ctx(budgetMs)).then(
        (r) => ({ ok: true as const, body: r.body }),
        (error: unknown) => ({ ok: false as const, failure: classify(error) }),
      );

    try {
      const shop = await attempt(
        shopById(args.shopId),
        this.settings.budgetsMs.shop,
      );
      if (!shop.ok) {
        const status = shop.failure.status;
        if (status === 404 || status === 403)
          throw new BffProblem('shop_not_found');
        throw requiredFailureProblem(shop.failure);
      }

      const sectionBudget = this.settings.budgetsMs.product;
      const [stats, today, rank] = await Promise.all([
        attempt(shopStats(args.shopId, args.days), sectionBudget),
        attempt(shopDashboardToday(args.shopId), sectionBudget),
        attempt(shopRank(args.shopId), sectionBudget),
      ]);

      const errors: SellerOverviewError[] = [];
      const valueOf = <T>(section: Section, outcome: Outcome<T>): T | null => {
        if (outcome.ok) return outcome.body;
        if (outcome.failure.unauthorized)
          throw requiredFailureProblem(outcome.failure);
        if (!outcome.failure.aborted)
          errors.push({
            section,
            code: outcome.failure.code,
            retryable: outcome.failure.retryable,
          });
        return null;
      };
      const rankValue: SellerOverviewResponse['rank'] =
        !rank.ok && rank.failure.problemCode === 'not_ranked'
          ? { notRanked: true }
          : valueOf('rank', rank);
      return {
        shop: shop.body,
        stats: valueOf('stats', stats),
        today: valueOf('today', today),
        rank: rankValue,
        errors,
      };
    } finally {
      controller.abort(); // nothing outstanding may keep working after the answer
    }
  }
}

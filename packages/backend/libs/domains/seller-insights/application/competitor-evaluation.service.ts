import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { ProductQueryService, type ProductDto } from '@app/domains/catalog';
import { MembershipQueryService } from '@app/domains/tenancy';
import { shouldAlert, eventIdFor } from '../domain/alert-rule';
import {
  TARGET_REPOSITORY,
  WATCH_REPOSITORY,
  type TargetRepository,
  type WatchRecord,
  type WatchRepository,
} from '../domain/crawler-ports';
import { CompetitorPriceDropped } from './events/seller-insights-events';
import { crawlerMetrics } from './crawler.metrics';

/** Most ids the product and membership R1 reads take per call, and the watches evaluated per transaction (FR-025). */
export const EVALUATION_BATCH = 500;

/** What one batch needs from other domains, read before the transaction opens (III.3, research D-08). */
export interface EvaluationContext {
  products: Map<string, ProductDto>;
  owners: Map<string, Array<{ userId: string }>>;
}

/** The observation a batch is evaluated against. */
export interface ObservedTarget {
  id: string;
  host: string;
  observationNo: number;
  priceMinor: number;
  currency: string;
  /** The crawl that saw the price, for the log line; absent when a registration evaluates the watch. */
  crawlId?: string;
}

/**
 * Per-watch evaluation of an observation (S41 FR-025 to FR-028): which watches the new price undercuts, and one outbox
 * event per owner of each. A watch is evaluated for observation N at most once (`claimEvaluation`), and the events of
 * a batch are written in the transaction that claims it, so a failure leaves nothing half-done.
 */
@Injectable()
export class CompetitorEvaluationService {
  private readonly logger = new Logger(CompetitorEvaluationService.name);

  constructor(
    @Inject(WATCH_REPOSITORY) private readonly watches: WatchRepository,
    @Inject(TARGET_REPOSITORY) private readonly targets: TargetRepository,
    private readonly products: ProductQueryService,
    private readonly members: MembershipQueryService,
    private readonly outbox: OutboxService,
    private readonly transactions: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Products and owners of up to 500 watches, in one read each. Call outside a transaction. */
  async prefetch(
    watches: Array<Pick<WatchRecord, 'productId' | 'shopId'>>,
    known?: { products?: Map<string, ProductDto> },
  ): Promise<EvaluationContext> {
    const productIds = [...new Set(watches.map((w) => w.productId))];
    const shopIds = [...new Set(watches.map((w) => w.shopId))];
    const products =
      known?.products ?? (await this.products.getProductsByIds(productIds));
    const owners =
      shopIds.length === 0
        ? new Map<string, Array<{ userId: string }>>()
        : await this.members.getMembersByShopIds(shopIds, ['OWNER']);
    return { products, owners };
  }

  /** Must run inside a transaction: the claim and the outbox rows commit together. Returns the events written. */
  async evaluateBatch(
    context: EvaluationContext,
    observed: ObservedTarget,
    watches: WatchRecord[],
  ): Promise<number> {
    if (watches.length === 0) return 0;
    const claimed = new Set(
      await this.watches.claimEvaluation(
        watches.map((w) => w.id),
        observed.observationNo,
        observed.priceMinor,
      ),
    );
    const now = this.clock.now();
    const events: ReturnType<typeof CompetitorPriceDropped.create>[] = [];
    for (const watch of watches) {
      if (!claimed.has(watch.id)) continue;
      const product = context.products.get(watch.productId);
      const verdict = shouldAlert({
        competitorPriceMinor: observed.priceMinor,
        competitorCurrency: observed.currency,
        yourPriceMinor: product?.priceMinor ?? 0,
        yourCurrency: product?.currency ?? '',
        productActive: product?.status === 'ACTIVE',
        shopActive: true,
        lastEvaluatedPriceMinor: watch.lastEvaluatedPriceMinor,
      });
      if (!verdict.alert || !product) {
        crawlerMetrics.evaluation(verdict.outcome);
        continue;
      }
      const owners = context.owners.get(watch.shopId) ?? [];
      if (owners.length === 0) {
        crawlerMetrics.evaluation('no_recipient');
        this.logger.warn(
          JSON.stringify({
            event: 'competitor_alert_no_recipient',
            ...(observed.crawlId && { crawlId: observed.crawlId }),
            targetId: observed.id,
            host: observed.host,
            watchId: watch.id,
            shopId: watch.shopId,
          }),
        );
        continue;
      }
      crawlerMetrics.evaluation('alert');
      for (const owner of owners)
        events.push({
          ...CompetitorPriceDropped.create(
            watch.id,
            observed.observationNo,
            {
              watchId: watch.id,
              shopId: watch.shopId,
              productId: watch.productId,
              productTitle: product.title,
              host: observed.host,
              competitorPriceMinor: observed.priceMinor,
              yourPriceMinor: product.priceMinor,
              currency: observed.currency,
              ownerId: owner.userId,
              priceVersion: observed.observationNo,
            },
            now,
          ),
          eventId: eventIdFor(watch.id, observed.observationNo, owner.userId),
        });
    }
    await this.outbox.append(events);
    crawlerMetrics.alert(events.length);
    return events.length;
  }

  /**
   * Every remaining batch of the target's current observation, each in its own transaction, then marks the target
   * fully evaluated. Safe to repeat: watches already claimed for this observation are not pending any more.
   */
  async evaluatePending(targetId: string): Promise<void> {
    for (;;) {
      const target = await this.targets.findById(targetId);
      if (
        !target ||
        target.observationNo === 0 ||
        target.lastPriceMinor === null ||
        target.currency === null
      )
        return;
      const pending = await this.watches.pendingEvaluation(
        target.id,
        target.observationNo,
        EVALUATION_BATCH,
      );
      if (pending.length === 0) {
        await this.targets.setEvaluated(target.id, target.observationNo);
        return;
      }
      const context = await this.prefetch(pending);
      await this.transactions.run(() =>
        this.evaluateBatch(
          context,
          {
            id: target.id,
            host: target.host,
            observationNo: target.observationNo,
            priceMinor: target.lastPriceMinor!,
            currency: target.currency!,
          },
          pending,
        ),
      );
    }
  }
}

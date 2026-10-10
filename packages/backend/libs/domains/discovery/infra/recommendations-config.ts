import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';

/** The validated recommendations settings (S34 FR-029); keys, defaults and checks live in `common/config/recommendations-config.ts`. */
@Injectable()
export class RecommendationsSettings {
  readonly minCoOrders: number;
  readonly minBuyers: number;
  readonly topN: number;
  readonly windowDays: number;
  readonly buckets: number;
  readonly ttlSeconds: number;
  readonly expandSeeds: number;
  readonly hopDecay: number;
  readonly storeBudgetMs: number;
  readonly productBudgetMs: number;
  readonly shopBudgetMs: number;
  readonly basketMin: number;
  readonly basketMax: number;

  constructor(config: ApiConfigService) {
    this.minCoOrders = Number(config.get('rec_min_co_orders'));
    this.minBuyers = Number(config.get('rec_min_buyers'));
    this.topN = Number(config.get('rec_top_n'));
    this.windowDays = Number(config.get('rec_window_days'));
    this.buckets = Number(config.get('rec_buckets'));
    this.ttlSeconds = Number(config.get('rec_ttl_seconds'));
    this.expandSeeds = Number(config.get('rec_expand_seeds'));
    this.hopDecay = Number(config.get('rec_hop_decay'));
    this.storeBudgetMs = Number(config.get('rec_store_budget_ms'));
    this.productBudgetMs = Number(config.get('rec_product_budget_ms'));
    this.shopBudgetMs = Number(config.get('rec_shop_budget_ms'));
    this.basketMin = Number(config.get('rec_basket_min'));
    this.basketMax = Number(config.get('rec_basket_max'));
  }
}

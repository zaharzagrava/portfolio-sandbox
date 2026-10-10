import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import {
  validateTrendingSettings,
  type TrendingSettingsValues,
} from '../domain/trending-config';

/**
 * The validated trending settings (S35 FR-026). Per-key ranges are checked when the configuration loads (joi names the
 * key); the cross-field rule on retention is checked here, so a bad value stops the application from starting.
 */
@Injectable()
export class TrendingSettings implements TrendingSettingsValues {
  readonly weightView: number;
  readonly weightCart: number;
  readonly windowSeconds: number;
  readonly latenessSeconds: number;
  readonly idleSeconds: number;
  readonly heapK: number;
  readonly allWidth: number;
  readonly categoryWidth: number;
  readonly depth: number;
  readonly categoryCap: number;
  readonly memoryBudgetMb: number;
  readonly retentionSeconds: number;
  readonly aggregateBudgetMs: number;
  readonly productBudgetMs: number;
  readonly shopBudgetMs: number;
  readonly mergeBudgetMs: number;
  readonly connectTimeoutMs: number;
  readonly shutdownDeadlineMs: number;
  readonly filterBits: number;
  readonly tickMs: number;
  readonly mergeBackoffBaseMs: number;

  constructor(config: ApiConfigService) {
    const n = (key: Parameters<ApiConfigService['get']>[0]) =>
      Number(config.get(key));
    this.weightView = n('trending_weight_view');
    this.weightCart = n('trending_weight_cart');
    this.windowSeconds = n('trending_window_seconds');
    this.latenessSeconds = n('trending_lateness_seconds');
    this.idleSeconds = n('trending_idle_seconds');
    this.heapK = n('trending_heap_k');
    this.allWidth = n('trending_all_width');
    this.categoryWidth = n('trending_category_width');
    this.depth = n('trending_depth');
    this.categoryCap = n('trending_category_cap');
    this.memoryBudgetMb = n('trending_memory_budget_mb');
    this.retentionSeconds = n('trending_retention_seconds');
    this.aggregateBudgetMs = n('trending_aggregate_budget_ms');
    this.productBudgetMs = n('trending_product_budget_ms');
    this.shopBudgetMs = n('trending_shop_budget_ms');
    this.mergeBudgetMs = n('trending_merge_budget_ms');
    this.connectTimeoutMs = n('trending_connect_timeout_ms');
    this.shutdownDeadlineMs = n('trending_shutdown_deadline_ms');
    this.filterBits = n('trending_filter_bits');
    this.tickMs = n('trending_tick_ms');
    this.mergeBackoffBaseMs = n('trending_merge_backoff_base_ms');
    const violations = validateTrendingSettings(this);
    if (violations.length > 0)
      throw new Error(
        `invalid trending configuration: ${violations.map((v) => `${v.key} ${v.message}`).join('; ')}`,
      );
  }
}

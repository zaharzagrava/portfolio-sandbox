import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';

/** The validated autocomplete settings (S33 FR-039); the keys, defaults and checks live in `common/config/autocomplete-config.ts`. */
@Injectable()
export class AutocompleteSettings {
  readonly catalogBudgetMs: number;
  readonly typoBudgetMs: number;
  readonly k: number;
  readonly depth: number;
  readonly minSearchers: number;
  readonly windowDays: number;
  readonly cap: number;
  readonly pollMs: number;
  readonly retentionCount: number;
  readonly retentionGraceMs: number;
  readonly logQueryTimeoutMs: number;
  readonly blocklist: string[];

  constructor(config: ApiConfigService) {
    this.catalogBudgetMs = Number(config.get('autocomplete_catalog_budget_ms'));
    this.typoBudgetMs = Number(config.get('autocomplete_typo_budget_ms'));
    this.k = Number(config.get('autocomplete_k'));
    this.depth = Number(config.get('autocomplete_depth'));
    this.minSearchers = Number(config.get('autocomplete_min_searchers'));
    this.windowDays = Number(config.get('autocomplete_window_days'));
    this.cap = Number(config.get('autocomplete_cap'));
    this.pollMs = Number(config.get('autocomplete_poll_ms'));
    this.retentionCount = Number(config.get('autocomplete_retention_count'));
    this.retentionGraceMs = Number(
      config.get('autocomplete_retention_grace_ms'),
    );
    this.logQueryTimeoutMs = Number(
      config.get('autocomplete_log_query_timeout_ms'),
    );
    this.blocklist = String(config.get('autocomplete_blocklist') ?? '')
      .split(',')
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length > 0);
  }
}

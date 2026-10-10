import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { Environment } from '@app/common/types';
import {
  DEFAULT_BOOST_WEIGHTS,
  type BoostWeights,
} from '../domain/boost';
import {
  PRODUCTION_PROFILE,
  TEST_PROFILE,
  type IndexProfile,
} from '../domain/index-definition';

/** The validated search settings (S32 FR-061) with typed accessors; secrets fall back to a random value outside production. */
@Injectable()
export class SearchSettings {
  private readonly fallbackLogSecret = randomBytes(32).toString('hex');
  private readonly fallbackSigningKey = randomBytes(32).toString('hex');

  constructor(private readonly config: ApiConfigService) {}

  get searchBudgetMs(): number {
    return Number(this.config.get('search_budget_ms'));
  }

  get embeddingBudgetMs(): number {
    return Number(this.config.get('embedding_budget_ms'));
  }

  /** How long one instance may keep using an index list it read (the dual-write wait of a run is twice this). */
  get registryTtlMs(): number {
    return Number(this.config.get('search_registry_ttl_ms'));
  }

  /** How long the verification gate keeps comparing counts while in-flight writes drain. */
  get reindexVerifyWaitMs(): number {
    return Number(this.config.get('search_reindex_verify_wait_ms'));
  }

  get tombstoneRetentionDays(): number {
    return Number(this.config.get('search_tombstone_retention_days'));
  }

  get previousIndexRetentionHours(): number {
    return Number(this.config.get('search_previous_index_retention_hours'));
  }

  get logSecret(): string {
    return (this.config.get('search_log_secret') as string | undefined) || this.fallbackLogSecret;
  }

  get signingKey(): string {
    return (
      (this.config.get('search_id_signing_key') as string | undefined) ||
      this.fallbackSigningKey
    );
  }

  get boostWeights(): BoostWeights {
    const raw = this.config.get('search_boost_weights') as string | undefined;
    if (!raw) return DEFAULT_BOOST_WEIGHTS;
    const parsed = JSON.parse(raw) as Partial<BoostWeights>;
    return {
      ...DEFAULT_BOOST_WEIGHTS,
      ...parsed,
      tier: { ...DEFAULT_BOOST_WEIGHTS.tier, ...(parsed.tier ?? {}) },
    };
  }

  get indexProfile(): IndexProfile {
    const base =
      this.config.get('node_env') === Environment.production
        ? PRODUCTION_PROFILE
        : TEST_PROFILE;
    return {
      ...base,
      refreshInterval: String(this.config.get('search_refresh_interval')),
    };
  }
}

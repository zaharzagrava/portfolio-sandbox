import { Inject, Injectable } from '@nestjs/common';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import {
  REINDEX_RUN_REPOSITORY,
  type ReindexRunRepository,
} from '../domain/ports';
import { IndexBootstrapService } from './index-bootstrap.service';
import { PRODUCTS_ALIAS } from './search-index-names';
import { SearchSettings } from './search-settings';

export { PRODUCTS_ALIAS };


/**
 * Which concrete indices a projector writes to (R-05): the index behind the alias, the index an active run is
 * building and the retained previous index (so a rollback loses nothing). Resolved from the engine and the run table
 * with a one-second cache; a run waits two cache lifetimes before it starts replaying, so every instance writes to
 * the new index before the replay begins.
 */
@Injectable()
export class SearchIndexRegistry {
  private cached: { at: number; live: string[]; all: string[] } | null = null;

  constructor(
    private readonly engine: SearchEngineClient,
    @Inject(REINDEX_RUN_REPOSITORY) private readonly runs: ReindexRunRepository,
    private readonly bootstrap: IndexBootstrapService,
    private readonly settings: SearchSettings,
  ) {}

  /** Cache lifetime; a run waits twice this before it starts replaying, so every instance writes to its index. */
  get ttlMs(): number {
    return this.settings.registryTtlMs;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async resolve(): Promise<{ live: string[]; all: string[] }> {
    // wall time on purpose: the cache bounds staleness between instances, whatever the business clock says
    const now = Date.now();
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached;
    let live = await this.engine.aliasTargets(PRODUCTS_ALIAS);
    // a concrete index named like the alias (before aliases were used) is the live index until a run replaces it
    if (live.length === 0 && (await this.engine.indexExists(PRODUCTS_ALIAS)))
      live = [PRODUCTS_ALIAS];
    if (live.length === 0) {
      // First use after an engine outage at boot: create the empty index now (never touches an existing alias).
      await this.bootstrap.ensureLiveIndex();
      live = await this.engine.aliasTargets(PRODUCTS_ALIAS);
    }
    const retained = await this.runs.retainedIndexes();
    const all = [...new Set([...live, ...retained])];
    this.cached = { at: now, live, all };
    return this.cached;
  }

  /** The indices the alias points to (normally one). */
  async live(): Promise<string[]> {
    return (await this.resolve()).live;
  }

  /** The live index first, then every other index that must receive the same writes. */
  async writeSet(): Promise<string[]> {
    return (await this.resolve()).all;
  }
}

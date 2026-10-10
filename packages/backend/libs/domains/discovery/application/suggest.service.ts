import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SUGGEST_LIMITS,
  suggestQuerySchema,
  type SuggestDegradedReason,
  type SuggestResponse,
} from '@marketplace-sandbox/contracts';
import {
  AUTOCOMPLETE_CLOCK,
  CATALOG_TITLE_SOURCE,
  CatalogTimeoutError,
  type AutocompleteClock,
  type CatalogTitleSource,
} from '../domain/autocomplete-ports';
import { CatalogCircuit } from '../domain/catalog-circuit';
import { containsBlocked } from '../domain/query-eligibility';
import { normaliseQuery } from '../domain/query-text';
import { SearchValidationError } from '../domain/search-errors';
import { blendSuggestions, CATALOG_CAP } from '../domain/suggestion-blend';
import { AutocompleteSettings } from '../infra/autocomplete-config';
import {
  autocompleteCircuitState,
  autocompleteDegraded,
  autocompleteRequests,
  autocompleteSourceDuration,
} from '../infra/autocomplete-metrics';
import { QueryIndexService } from './query-index.service';

const MIN_CATALOG_PREFIX = 2;
/** Titles asked of the catalog per prefix: enough to survive the blocklist and the de-duplication. */
const CATALOG_FETCH = 2 * CATALOG_CAP;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 5_000;
const BREAKER = { failureThreshold: 5, openMs: 10_000 } as const;
/** Queries asked of the index per request (the most the blend can use). */
const INDEX_FETCH = SUGGEST_LIMITS.limit.max;

type CatalogResult =
  | { titles: string[]; failure?: undefined }
  | { titles: []; failure: 'catalog_timeout' | 'catalog_unavailable' };

const TIMED_OUT = Symbol('timed out');

/**
 * One call per `/suggest` request (II.1): validates, reduces the prefix, reads the query index (in memory), the catalog
 * through its port (per-prefix 60 s cache, breaker, 40 ms budget with an aborted call), applies the serve-time blocklist to
 * every source and blends. A source that fails costs only its own entries and is named in `degraded`.
 */
@Injectable()
export class SuggestService {
  private readonly logger = new Logger(SuggestService.name);
  private readonly circuit: CatalogCircuit;
  private readonly cache = new Map<
    string,
    { titles: string[]; expiresAt: number }
  >();
  private readonly inflight = new Map<string, Promise<CatalogResult>>();

  constructor(
    private readonly index: QueryIndexService,
    @Inject(CATALOG_TITLE_SOURCE) private readonly catalog: CatalogTitleSource,
    @Inject(AUTOCOMPLETE_CLOCK) private readonly clock: AutocompleteClock,
    private readonly settings: AutocompleteSettings,
  ) {
    this.circuit = new CatalogCircuit({
      ...BREAKER,
      now: () => this.clock.now().getTime(),
    });
  }

  async suggest(rawQuery: Record<string, unknown>): Promise<SuggestResponse> {
    const { prefix, limit } = this.validate(rawQuery);
    const degraded: SuggestDegradedReason[] = [];
    if (prefix.length === 0) return this.finish(prefix, [], degraded, 0);

    const catalogCall =
      [...prefix].length >= MIN_CATALOG_PREFIX
        ? this.catalogTitles(prefix)
        : Promise.resolve<CatalogResult>({ titles: [] });

    const started = process.hrtime.bigint();
    const queries = this.index
      .lookup(prefix, INDEX_FETCH)
      .filter((q) => !containsBlocked(q, this.settings.blocklist));
    autocompleteSourceDuration.record(
      Number(process.hrtime.bigint() - started) / 1e9,
      { source: 'query' },
    );
    if (!this.index.loaded) degraded.push('query_index_unavailable');

    const catalog = await catalogCall;
    if (catalog.failure) degraded.push(catalog.failure);

    const suggestions = blendSuggestions({
      limit,
      queries,
      catalog: catalog.titles.filter(
        (t) => !containsBlocked(t, this.settings.blocklist),
      ),
    });
    return this.finish(prefix, suggestions, degraded, [...prefix].length);
  }

  private finish(
    prefix: string,
    suggestions: SuggestResponse['suggestions'],
    degraded: SuggestDegradedReason[],
    prefixLength: number,
  ): SuggestResponse {
    autocompleteRequests.add(1, {
      status: degraded.length > 0 ? 'degraded' : 'ok',
    });
    for (const reason of degraded) autocompleteDegraded.add(1, { reason });
    // the prefix is never logged (FR-019): its length and the reasons are enough to see a problem
    this.logger.debug(
      `suggest prefixLength=${prefixLength} results=${suggestions.length} degraded=[${degraded.join(',')}]`,
    );
    return { prefix, suggestions, degraded };
  }

  private validate(raw: Record<string, unknown>): {
    prefix: string;
    limit: number;
  } {
    const parsed = suggestQuerySchema.safeParse(raw);
    if (!parsed.success) {
      const fields = new Set<string>();
      for (const issue of parsed.error.issues) {
        if (issue.code === 'unrecognized_keys')
          for (const key of issue.keys) fields.add(key);
        else
          fields.add(issue.path.length > 0 ? String(issue.path[0]) : 'query');
      }
      autocompleteRequests.add(1, { status: 'invalid' });
      throw new SearchValidationError([...fields]);
    }
    const prefix = normaliseQuery(parsed.data.q).toLowerCase();
    if ([...prefix].length > SUGGEST_LIMITS.q.max) {
      autocompleteRequests.add(1, { status: 'invalid' });
      throw new SearchValidationError(['q']);
    }
    return { prefix, limit: parsed.data.limit ?? SUGGEST_LIMITS.limit.default };
  }

  /** Titles of visible products for a prefix: cache, then breaker, then one budgeted call shared by concurrent requests. */
  private catalogTitles(prefix: string): Promise<CatalogResult> {
    const now = this.clock.now().getTime();
    const hit = this.cache.get(prefix);
    if (hit && hit.expiresAt > now)
      return Promise.resolve({ titles: hit.titles });
    if (hit) this.cache.delete(prefix);

    const shared = this.inflight.get(prefix);
    if (shared) return shared;
    if (!this.circuit.tryAcquire()) {
      this.reportCircuit();
      return Promise.resolve({ titles: [], failure: 'catalog_unavailable' });
    }
    const call = this.callCatalog(prefix).finally(() => {
      this.inflight.delete(prefix);
      this.reportCircuit();
    });
    this.inflight.set(prefix, call);
    return call;
  }

  private async callCatalog(prefix: string): Promise<CatalogResult> {
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(TIMED_OUT);
      }, this.settings.catalogBudgetMs);
    });
    const started = process.hrtime.bigint();
    const call = this.catalog.suggestTitles(
      prefix,
      CATALOG_FETCH,
      abort.signal,
    );
    call.catch(() => undefined); // an abandoned call may still reject later
    try {
      const outcome = await Promise.race([call, budget]);
      if (outcome === TIMED_OUT) {
        this.circuit.recordFailure();
        return { titles: [], failure: 'catalog_timeout' };
      }
      this.circuit.recordSuccess();
      this.remember(prefix, outcome);
      return { titles: outcome };
    } catch (error) {
      this.circuit.recordFailure();
      return {
        titles: [],
        failure:
          error instanceof CatalogTimeoutError
            ? 'catalog_timeout'
            : 'catalog_unavailable',
      };
    } finally {
      clearTimeout(timer);
      autocompleteSourceDuration.record(
        Number(process.hrtime.bigint() - started) / 1e9,
        { source: 'catalog' },
      );
    }
  }

  /** Only successes are cached; the map is bounded and evicts the oldest entry first. */
  private remember(prefix: string, titles: string[]) {
    this.cache.set(prefix, {
      titles,
      expiresAt: this.clock.now().getTime() + CACHE_TTL_MS,
    });
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private reportCircuit() {
    autocompleteCircuitState.set(
      { closed: 0, half_open: 1, open: 2 }[this.circuit.state],
    );
  }
}

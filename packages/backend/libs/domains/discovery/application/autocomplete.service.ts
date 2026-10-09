import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { gunzipSync } from 'node:zlib';
import { buffer } from 'node:stream/consumers';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { AUTOCOMPLETE_POINTER } from '../infra/autocomplete-builder.jobs';
import { normalizeQuery, Suggestion, TopKTrie } from '../domain/top-k-trie';

const POLL_MS = 30_000;
const ES_BUDGET_MS = 40;

export interface SuggestResponse {
  queries: string[];
  products: string[];
  /** true when the product half timed out and was dropped (partial response). */
  partial: boolean;
}

/**
 * Online half: the trie lives IN MEMORY on every API node (µs lookups, no
 * network hop per keystroke). A background poll swaps in a new snapshot
 * atomically (build off to the side, then replace the reference). Product
 * completions come from ES with a hard 40 ms budget - if ES is slow the
 * response degrades to query suggestions only instead of waiting.
 */
@Injectable()
export class AutocompleteService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AutocompleteService.name);
  private trie = new TopKTrie();
  private version: string | null = null;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisService,
    private readonly storage: ObjectStorage,
    private readonly elasticsearch: ElasticsearchService,
  ) {}

  onApplicationBootstrap() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async refresh(): Promise<boolean> {
    try {
      const pointer = await this.redis.client.get(AUTOCOMPLETE_POINTER);
      if (!pointer || pointer === this.version) return false;
      const raw = await buffer(
        await this.storage.getStream(`autocomplete/${pointer}.json.gz`),
      );
      const items = JSON.parse(
        gunzipSync(raw).toString('utf8'),
      ) as Suggestion[];
      this.trie = await TopKTrie.buildFrom(items);
      this.version = pointer;
      this.logger.log(
        `autocomplete ${pointer} loaded (${items.length} queries, ${this.trie.size()} nodes)`,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `autocomplete refresh failed (serving ${this.version ?? 'nothing'}): ${(error as Error).message}`,
      );
      return false;
    }
  }

  /** For specs and the builder's smoke check. */
  useTrie(trie: TopKTrie) {
    this.trie = trie;
  }

  async suggest(raw: string): Promise<SuggestResponse> {
    const prefix = normalizeQuery(raw);
    if (prefix.length < 1) return { queries: [], products: [], partial: false };
    const queries = this.trie.lookup(prefix, 8).map((s) => s.query);

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), ES_BUDGET_MS);
    try {
      const products =
        prefix.length >= 2
          ? await this.elasticsearch.suggestTitles(prefix, 5, abort.signal)
          : [];
      return { queries, products, partial: false };
    } catch {
      return { queries, products: [], partial: true };
    } finally {
      clearTimeout(timeout);
    }
  }
}

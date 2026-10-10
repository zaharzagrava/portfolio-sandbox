import { Injectable } from '@nestjs/common';
import { Client } from '@elastic/elasticsearch';
import { ApiConfigService } from '@app/common/config';
import { classifyEngineError } from './search-engine.errors';

export interface EngineCallOptions {
  /** Hard bound on the HTTP request; every call has one (default 10 s). */
  timeoutMs?: number;
  /** Transport retries on a connection failure; a latency-bound caller (search) passes 0. */
  maxRetries?: number;
  signal?: AbortSignal;
}

export type AliasAction = Record<string, Record<string, unknown>>;

type Params = Record<string, any>;

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Generic search-engine client (S32 D-16): index, alias, document, query and synonyms operations with an explicit
 * per-call timeout and failures classified into `EngineUnavailableError` / `EngineRejectedError`. It knows no product
 * names; mappings, queries and index names belong to the capability that owns the index.
 */
@Injectable()
export class SearchEngineClient {
  private readonly client: Client;

  constructor(config: ApiConfigService) {
    this.client = new Client({ node: config.get('elasticsearch_node') });
  }

  /** The underlying library client, for callers that own an index of their own and need an operation not wrapped here. */
  getClient(): Client {
    return this.client;
  }

  private async call<T>(
    run: (options: Params) => Promise<T>,
    opts: EngineCallOptions = {},
  ): Promise<T> {
    try {
      return await run({
        requestTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
        ...(opts.signal && { signal: opts.signal }),
      });
    } catch (error) {
      throw classifyEngineError(error);
    }
  }

  search(params: Params, opts?: EngineCallOptions): Promise<any> {
    return this.call(
      (o) => this.client.search(params as never, o) as Promise<any>,
      opts,
    );
  }

  mget(
    index: string,
    ids: string[],
    opts?: EngineCallOptions & { sourceIncludes?: string[] },
  ): Promise<any> {
    if (ids.length === 0) return Promise.resolve({ docs: [] });
    return this.call(
      (o) =>
        this.client.mget(
          {
            index,
            ids,
            ...(opts?.sourceIncludes && { _source: opts.sourceIncludes }),
          } as never,
          o,
        ) as Promise<any>,
      opts,
    );
  }

  /** Raw bulk; the caller reads per-item results (`items`). A transport failure throws, item errors do not. */
  bulk(
    operations: object[],
    opts?: EngineCallOptions & { refresh?: boolean },
  ): Promise<any> {
    return this.call(
      (o) =>
        this.client.bulk(
          { operations, refresh: opts?.refresh ?? false } as never,
          o,
        ) as Promise<any>,
      { timeoutMs: 60_000, ...opts },
    );
  }

  async count(
    index: string,
    query?: object,
    opts?: EngineCallOptions,
  ): Promise<number> {
    const res = await this.call(
      (o) =>
        this.client.count(
          { index, ...(query && { query }) } as never,
          o,
        ) as Promise<any>,
      opts,
    );
    return res.count as number;
  }

  refresh(index: string, opts?: EngineCallOptions): Promise<unknown> {
    return this.call((o) => this.client.indices.refresh({ index }, o), opts);
  }

  async indexExists(
    index: string,
    opts?: EngineCallOptions,
  ): Promise<boolean> {
    return this.call(
      (o) => this.client.indices.exists({ index }, o) as Promise<boolean>,
      opts,
    );
  }

  /**
   * Creates an index (optionally with aliases in the same call). An index that already exists is a success: two
   * instances starting together both end with one index. Returns whether this call created it.
   */
  async createIndex(
    index: string,
    definition: Params,
    opts?: EngineCallOptions,
  ): Promise<boolean> {
    try {
      await this.call(
        (o) => this.client.indices.create({ index, ...definition } as never, o),
        { timeoutMs: 30_000, ...opts },
      );
      return true;
    } catch (error) {
      const type = (error as { type?: string }).type;
      if (type === 'resource_already_exists_exception') return false;
      throw error;
    }
  }

  async deleteIndex(index: string, opts?: EngineCallOptions): Promise<void> {
    await this.call(
      (o) =>
        this.client.indices.delete({ index, ignore_unavailable: true }, o),
      { timeoutMs: 30_000, ...opts },
    );
  }

  /** Names of the indices an alias points to (empty when the alias does not exist). */
  async aliasTargets(
    alias: string,
    opts?: EngineCallOptions,
  ): Promise<string[]> {
    try {
      const res = await this.call(
        (o) => this.client.indices.getAlias({ name: alias }, o),
        opts,
      );
      return Object.keys(res);
    } catch (error) {
      if ((error as { status?: number }).status === 404) return [];
      throw error;
    }
  }

  /** Every concrete index whose name matches a pattern, with its `_meta` and alias list. */
  async listIndices(
    pattern: string,
    opts?: EngineCallOptions,
  ): Promise<
    Record<
      string,
      {
        meta: Record<string, unknown>;
        aliases: string[];
        /** creation time of the index, epoch ms */
        createdAt: number | null;
      }
    >
  > {
    try {
      const res = await this.call(
        (o) =>
          this.client.indices.get(
            { index: pattern, ignore_unavailable: true },
            o,
          ),
        opts,
      );
      return Object.fromEntries(
        Object.entries(res).map(([name, info]) => [
          name,
          {
            meta: ((info.mappings as Params)?._meta ?? {}) as Record<
              string,
              unknown
            >,
            aliases: Object.keys(info.aliases ?? {}),
            createdAt: Number(
              (info.settings as Params)?.index?.creation_date ?? 0,
            ) || null,
          },
        ]),
      );
    } catch (error) {
      if ((error as { status?: number }).status === 404) return {};
      throw error;
    }
  }

  /** Atomic alias update: every action applies or none (add, remove, remove_index). */
  async updateAliases(
    actions: AliasAction[],
    opts?: EngineCallOptions,
  ): Promise<void> {
    await this.call(
      (o) => this.client.indices.updateAliases({ actions } as never, o),
      { timeoutMs: 30_000, ...opts },
    );
  }

  async updateByQuery(
    params: Params,
    opts?: EngineCallOptions,
  ): Promise<{ updated: number; versionConflicts: number }> {
    const res = await this.call(
      (o) =>
        this.client.updateByQuery(
          {
            conflicts: 'proceed',
            refresh: true,
            wait_for_completion: true,
            ...params,
          } as never,
          o,
        ) as Promise<any>,
      { timeoutMs: 120_000, ...opts },
    );
    return {
      updated: res.updated ?? 0,
      versionConflicts: res.version_conflicts ?? 0,
    };
  }

  async deleteByQuery(
    params: Params,
    opts?: EngineCallOptions,
  ): Promise<{ deleted: number }> {
    const res = await this.call(
      (o) =>
        this.client.deleteByQuery(
          {
            conflicts: 'proceed',
            refresh: true,
            wait_for_completion: true,
            ...params,
          } as never,
          o,
        ) as Promise<any>,
      { timeoutMs: 120_000, ...opts },
    );
    return { deleted: res.deleted ?? 0 };
  }

  async getSynonyms(
    id: string,
    opts?: EngineCallOptions,
  ): Promise<string[] | null> {
    try {
      const res = await this.call(
        (o) => this.client.synonyms.getSynonym({ id }, o),
        opts,
      );
      return (res.synonyms_set as { synonyms: string }[]).map(
        (r) => r.synonyms,
      );
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  /** Replaces the whole set; the engine reloads every analyzer that uses it (no index close, no reindex). */
  async putSynonyms(
    id: string,
    rules: string[],
    opts?: EngineCallOptions,
  ): Promise<void> {
    await this.call(
      (o) =>
        this.client.synonyms.putSynonym(
          { id, synonyms_set: rules.map((synonyms) => ({ synonyms })) },
          o,
        ),
      { timeoutMs: 5_000, ...opts },
    );
  }

  async ping(opts?: EngineCallOptions): Promise<void> {
    await this.call((o) => this.client.ping({}, o), opts);
  }
}

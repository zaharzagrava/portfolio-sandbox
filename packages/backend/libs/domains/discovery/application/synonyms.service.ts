import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import {
  EngineRejectedError,
  EngineUnavailableError,
} from '@app/infrastructure/elasticsearch/search-engine.errors';
import { parseSynonymRules } from '../domain/synonym-rules';
import {
  SYNONYM_SET_REPOSITORY,
  type SynonymSetRepository,
  type SynonymSetSnapshot,
} from '../domain/ports';
import {
  InvalidSynonymRulesError,
  SearchUnavailableError,
  SynonymsVersionConflictError,
} from '../domain/search-errors';
import { SYNONYMS_SET_ID } from '../infra/index-bootstrap.service';
import { SearchAudit } from './reindex/reindex-audit';

/** The engine cannot hold an empty set; an empty edit stores this rule, which matches nothing a shopper types. */
const EMPTY_SET_PLACEHOLDER = '__no_synonyms__, __no_synonyms_alias__';
/** A claim older than this was abandoned by a crashed instance (the engine call itself is bounded by 5 s). */
const CLAIM_STALE_MS = 30_000;
/** How long a caller waits for another edit in flight before giving up with a conflict. */
const CLAIM_WAIT_MS = 5_000;
const CLAIM_POLL_MS = 40;

export interface SynonymsView {
  version: number;
  rules: string[];
  updatedAt: string;
  updatedBy: string | null;
}

export interface SynonymsPutResult {
  version: number;
  ruleCount: number;
  updatedAt: string;
  unchanged: boolean;
}

const sameRules = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((rule, i) => rule === b[i]);

const view = (s: SynonymSetSnapshot): SynonymsView => ({
  version: s.version,
  rules: s.rules,
  updatedAt: new Date(s.updatedAt).toISOString(),
  updatedBy: s.updatedBy,
});

/**
 * The persisted, versioned synonym set (S32 US6). An edit is: parse the grammar, claim the version (conditional update,
 * one winner), push the whole set to the engine outside any transaction, commit. The engine reloads its analyzers, so
 * the rules apply to every document without a reindex. A failed push releases the claim and leaves rules and version
 * as they were.
 */
@Injectable()
export class SynonymsService {
  constructor(
    @Inject(SYNONYM_SET_REPOSITORY) private readonly sets: SynonymSetRepository,
    private readonly engine: SearchEngineClient,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: SearchAudit,
  ) {}

  async get(): Promise<SynonymsView> {
    return view(await this.sets.current());
  }

  async put(
    input: { rules: string[]; expectedVersion: number },
    actorId: string,
  ): Promise<SynonymsPutResult> {
    const parsed = parseSynonymRules(input.rules);
    if (!parsed.ok) throw new InvalidSynonymRulesError(parsed.errors);
    const { rules } = parsed;

    const claimed = await this.claim(input.expectedVersion, rules);
    if (claimed.unchanged) {
      const current = claimed.current;
      return {
        version: current.version,
        ruleCount: current.rules.length,
        updatedAt: new Date(current.updatedAt).toISOString(),
        unchanged: true,
      };
    }

    const version = input.expectedVersion + 1;
    try {
      await this.engine.putSynonyms(
        SYNONYMS_SET_ID,
        rules.length > 0 ? rules : [EMPTY_SET_PLACEHOLDER],
      );
    } catch (error) {
      await this.sets.release(version);
      if (
        error instanceof EngineUnavailableError ||
        error instanceof EngineRejectedError
      )
        throw new SearchUnavailableError(error);
      throw error;
    }
    const committed = await this.sets.commit(
      version,
      actorId,
      this.clock.now(),
    );
    this.audit.record({
      actorId,
      action: 'search.synonyms.put',
      version: committed.version,
      ruleCount: committed.rules.length,
    });
    return {
      version: committed.version,
      ruleCount: committed.rules.length,
      updatedAt: new Date(committed.updatedAt).toISOString(),
      unchanged: false,
    };
  }

  /**
   * Either the edit is a no-op (the rules equal the committed ones, whatever version the caller read), or the claim
   * for `expectedVersion` is ours, or the set has moved on (409). A claim held by another edit in flight is waited for
   * so the loser reports the version the winner committed.
   */
  private async claim(
    expectedVersion: number,
    rules: string[],
  ): Promise<
    { unchanged: false } | { unchanged: true; current: SynonymSetSnapshot }
  > {
    const started = Date.now();
    for (;;) {
      const current = await this.sets.current();
      if (sameRules(current.rules, rules)) return { unchanged: true, current };
      if (current.version !== expectedVersion)
        throw new SynonymsVersionConflictError(current.version);
      const now = this.clock.now();
      const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
      if (await this.sets.claim(expectedVersion, rules, now, staleBefore))
        return { unchanged: false };
      if (Date.now() - started > CLAIM_WAIT_MS)
        throw new SynonymsVersionConflictError(current.version);
      if (await this.sets.claimInFlight(staleBefore))
        await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
    }
  }
}

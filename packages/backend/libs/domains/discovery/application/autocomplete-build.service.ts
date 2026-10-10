import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUTOCOMPLETE_CLOCK,
  QUERY_INDEX_SNAPSHOT_STORE,
  SEARCH_LOG_READER,
  SNAPSHOT_POINTER,
  type AutocompleteClock,
  type QueryIndexSnapshotStore,
  type SearchLogReader,
  type SnapshotPointer,
} from '../domain/autocomplete-ports';
import { isEligibleQuery } from '../domain/query-eligibility';
import {
  checksumOf,
  compareEntries,
  decodeSnapshot,
  encodeSnapshot,
  type SnapshotEntry,
  type SnapshotParams,
} from '../domain/snapshot-codec';
import { newSnapshotVersion } from '../domain/snapshot-pointer';
import { AutocompleteSettings } from '../infra/autocomplete-config';
import { autocompleteBuilds } from '../infra/autocomplete-metrics';

export type BuildOutcome =
  | { outcome: 'published'; version: string; queries: number }
  | { outcome: 'unchanged'; version: string; queries: number }
  | { outcome: 'skipped_empty' }
  | { outcome: 'superseded'; version: string };

/** Rows asked beyond the cap, so rows the eligibility rules drop cannot push an eligible query out of the top. */
const OVERFETCH = (cap: number): number => Math.max(1_000, Math.ceil(cap / 10));

/**
 * The hourly build (FR-020 to FR-030): read the distinct-searcher counts, keep what is eligible, write one immutable
 * checksummed snapshot, and move the pointer forward only. Nothing is published for an empty or unchanged result; a build
 * that lost the race to a newer one removes its own object. Old versions are trimmed afterwards.
 */
@Injectable()
export class AutocompleteBuildService {
  private readonly logger = new Logger(AutocompleteBuildService.name);

  constructor(
    @Inject(SEARCH_LOG_READER) private readonly log: SearchLogReader,
    @Inject(QUERY_INDEX_SNAPSHOT_STORE)
    private readonly store: QueryIndexSnapshotStore,
    @Inject(SNAPSHOT_POINTER) private readonly pointer: SnapshotPointer,
    @Inject(AUTOCOMPLETE_CLOCK) private readonly clock: AutocompleteClock,
    private readonly settings: AutocompleteSettings,
  ) {}

  async build(signal?: AbortSignal): Promise<BuildOutcome> {
    try {
      const outcome = await this.run(signal);
      autocompleteBuilds.add(1, { outcome: outcome.outcome });
      return outcome;
    } catch (error) {
      autocompleteBuilds.add(1, { outcome: 'failed' });
      throw error;
    }
  }

  private async run(signal?: AbortSignal): Promise<BuildOutcome> {
    const s = this.settings;
    const timeout = AbortSignal.timeout(s.logQueryTimeoutMs);
    const rows = await this.log.eligibleQueries(
      {
        windowDays: s.windowDays,
        minSearchers: s.minSearchers,
        cap: s.cap + OVERFETCH(s.cap),
      },
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    );
    const entries: SnapshotEntry[] = rows
      .filter(
        (r) =>
          r.searchers >= s.minSearchers &&
          isEligibleQuery(r.query, s.blocklist),
      )
      .map((r) => ({ query: r.query, searchers: r.searchers }))
      .sort(compareEntries)
      .slice(0, s.cap);
    if (entries.length === 0) return { outcome: 'skipped_empty' };

    const params: SnapshotParams = {
      windowDays: s.windowDays,
      minSearchers: s.minSearchers,
      cap: s.cap,
      k: s.k,
      depth: s.depth,
    };
    const pointed = await this.pointedSnapshot();
    if (
      pointed &&
      pointed.checksum === checksumOf(entries) &&
      isDeepStrictEqual(pointed.params, params)
    )
      return {
        outcome: 'unchanged',
        version: pointed.version,
        queries: entries.length,
      };

    const now = this.clock.now();
    const version = newSnapshotVersion(now, randomBytes(2).toString('hex'));
    await this.store.put(
      version,
      encodeSnapshot({ version, createdAt: now, params, entries }),
    );
    if (!(await this.pointer.compareAndSet(version))) {
      await this.store.delete(version);
      return { outcome: 'superseded', version };
    }
    await this.trim(now);
    this.logger.log(
      `autocomplete snapshot ${version}: ${entries.length} queries`,
    );
    return { outcome: 'published', version, queries: entries.length };
  }

  /** The snapshot the pointer names, when it can be read and trusted; otherwise `null` (the build then publishes). */
  private async pointedSnapshot() {
    try {
      const version = await this.pointer.read();
      if (!version) return null;
      const bytes = await this.store.get(version);
      return bytes ? decodeSnapshot(bytes) : null;
    } catch {
      return null;
    }
  }

  /** Keeps the newest versions, the pointed one and anything younger than the grace period (an in-flight build). */
  private async trim(now: Date): Promise<void> {
    try {
      const [objects, pointed] = await Promise.all([
        this.store.list(),
        this.pointer.read(),
      ]);
      const keep = new Set(
        [...objects]
          .sort((a, b) => (a.version < b.version ? 1 : -1))
          .slice(0, this.settings.retentionCount)
          .map((o) => o.version),
      );
      if (pointed) keep.add(pointed);
      const youngerThan = now.getTime() - this.settings.retentionGraceMs;
      for (const o of objects)
        if (!keep.has(o.version) && o.lastModified.getTime() <= youngerThan)
          await this.store.delete(o.version);
    } catch {
      // trimming is housekeeping: the next build tries again
      this.logger.warn('autocomplete snapshot retention could not run');
    }
  }
}

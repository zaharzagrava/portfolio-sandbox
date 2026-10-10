import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  AUTOCOMPLETE_CLOCK,
  QUERY_INDEX_SNAPSHOT_STORE,
  SNAPSHOT_POINTER,
  type AutocompleteClock,
  type QueryIndexSnapshotStore,
  type SnapshotPointer,
} from '../domain/autocomplete-ports';
import {
  decodeSnapshot,
  SnapshotLoadError,
  type SnapshotLoadReason,
} from '../domain/snapshot-codec';
import { TopKTrie } from '../domain/top-k-trie';
import { AutocompleteSettings } from '../infra/autocomplete-config';
import {
  autocompleteSnapshotAge,
  autocompleteSnapshotLoadFailures,
  autocompleteSnapshotVersion,
} from '../infra/autocomplete-metrics';

/** A store that does not answer must not wedge the poll: the pointer read is quick, a snapshot download may take longer. */
const POINTER_TIMEOUT_MS = 2_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('store did not answer')), ms);
  });
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

interface LoadedIndex {
  trie: TopKTrie;
  version: string;
  createdAt: Date;
}

/**
 * Serving half of the query index (FR-031 to FR-035): every node follows the snapshot pointer, verifies what it
 * downloads, builds the new trie off to the side and swaps it in by reference. A damaged, missing or unreachable
 * snapshot never replaces what is served. Refreshes are single-flight: overlapping callers share one download.
 */
@Injectable()
export class QueryIndexService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(QueryIndexService.name);
  private current: LoadedIndex | null = null;
  private inflight: Promise<boolean> | null = null;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(SNAPSHOT_POINTER) private readonly pointer: SnapshotPointer,
    @Inject(QUERY_INDEX_SNAPSHOT_STORE)
    private readonly store: QueryIndexSnapshotStore,
    @Inject(AUTOCOMPLETE_CLOCK) private readonly clock: AutocompleteClock,
    private readonly settings: AutocompleteSettings,
  ) {}

  onApplicationBootstrap() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.settings.pollMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Whether a snapshot is loaded; without one `/suggest` answers from the catalog and says `query_index_unavailable`. */
  get loaded(): boolean {
    return this.current !== null;
  }

  get version(): string | null {
    return this.current?.version ?? null;
  }

  /** Top completions for a normalised prefix from the snapshot this call sees (one reference read, so never a mix). */
  lookup(prefix: string, limit: number): string[] {
    const index = this.current;
    if (!index) return [];
    return index.trie.lookup(prefix, limit).map((s) => s.query);
  }

  /** Follows the pointer once; resolves to whether a new snapshot was loaded. Never rejects. */
  refresh(): Promise<boolean> {
    this.inflight ??= this.poll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private fail(reason: SnapshotLoadReason | 'missing' | 'pointer_unreachable') {
    autocompleteSnapshotLoadFailures.add(1, { reason });
    // the reason is a bounded label; neither the error text nor the object content is logged
    this.logger.warn(
      `autocomplete snapshot not loaded (${reason}); serving ${this.version ?? 'nothing'}`,
    );
  }

  private async poll(): Promise<boolean> {
    let target: string | null;
    try {
      target = await within(this.pointer.read(), POINTER_TIMEOUT_MS);
    } catch {
      this.fail('pointer_unreachable');
      return false;
    }
    this.reportAge();
    if (target === null || target === this.current?.version) return false;

    let bytes: Buffer | null;
    try {
      bytes = await within(this.store.get(target), DOWNLOAD_TIMEOUT_MS);
    } catch {
      this.fail('missing');
      return false;
    }
    if (bytes === null) {
      this.fail('missing');
      return false;
    }
    try {
      const snapshot = decodeSnapshot(bytes);
      const trie = await TopKTrie.buildFrom(
        snapshot.entries.map((e) => ({ query: e.query, count: e.searchers })),
        this.settings.k,
        this.settings.depth,
      );
      this.current = {
        trie,
        version: target,
        createdAt: new Date(snapshot.createdAt),
      };
      this.reportAge();
      this.logger.log(
        `autocomplete ${target} loaded (${snapshot.entries.length} queries)`,
      );
      return true;
    } catch (error) {
      this.fail(error instanceof SnapshotLoadError ? error.reason : 'corrupt');
      return false;
    }
  }

  private reportAge() {
    const index = this.current;
    autocompleteSnapshotVersion.set(
      index ? Math.floor(index.createdAt.getTime() / 1000) : 0,
    );
    autocompleteSnapshotAge.set(
      index
        ? Math.max(
            0,
            (this.clock.now().getTime() - index.createdAt.getTime()) / 1000,
          )
        : 0,
    );
  }
}

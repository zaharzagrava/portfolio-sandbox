import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { FlagRulesetSnapshot } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { TopicSubscriber } from '@app/infrastructure/realtime';
import {
  evaluate,
  rulesetUnavailable,
  type EvalContext,
  type Evaluation,
  type FlagDefinition,
  type FlagValue,
} from '../domain/evaluator';
import {
  EVAL_COUNTER_STORE,
  InvalidSnapshotError,
  RULESET_SOURCE,
  type EvalCounterStore,
  type RulesetSource,
} from '../domain/ports';
import { withTimeout } from '../domain/with-timeout';
import {
  flagsEvaluationsTotal,
  flagsRefreshFailuresTotal,
  flagsRulesetAgeSeconds,
  flagsRulesetIgnoredTotal,
  flagsRulesetRejectedTotal,
  flagsRulesetVersion,
} from './flags-metrics';

type SdkFlag = FlagRulesetSnapshot['flags'][number];

export const POLL_INTERVAL_MS = 30_000;
export const POLL_JITTER_MS = 5_000;
export const FLUSH_INTERVAL_MS = 30_000;
export const COLD_START_RETRY_MS = 5_000;
const TICK_MS = 1_000;
const SUBSCRIBE_TIMEOUT_MS = 2_000;

/**
 * Local-evaluation SDK, one per process (S38 US2). The whole ruleset lives in memory and `evaluate()` is a pure
 * synchronous call: no I/O, no throw on a bad key, and it keeps working with the last known ruleset when the cache and the
 * database are both down. The ruleset converges on the database truth: a push of the version triggers an immediate
 * refresh, polling every 30 s (+ up to 5 s jitter) is the fallback, and only a strictly newer, valid snapshot is applied.
 * A cold start with no store never blocks boot: the process is live, `ready` is false and a 5 s retry loads it later.
 * Evaluation counts are aggregated in memory and flushed per UTC day; a failed flush keeps them.
 *
 * Time is read from `Clock` and a 1 s ticker decides what is due, so a spec that moves the clock moves every interval.
 */
@Injectable()
export class FlagsClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FlagsClient.name);
  private ruleset: FlagRulesetSnapshot = { version: 0, flags: [] };
  private byKey = new Map<string, SdkFlag & FlagDefinition>();
  private loaded = false;
  private appliedAt = 0;
  private readonly counts = new Map<string, number>();
  private readonly metricCounts = new Map<string, number>();
  private ticker?: NodeJS.Timeout;
  private release?: () => Promise<void>;
  private subscribing = false;
  private refreshing: Promise<boolean> | null = null;
  private refreshAgain = false;
  private nextPollAt = 0;
  private nextFlushAt = 0;
  private nextRetryAt = 0;
  private warnedInvalid = false;
  private destroyed = false;

  constructor(
    @Inject(RULESET_SOURCE) private readonly source: RulesetSource,
    @Inject(EVAL_COUNTER_STORE) private readonly store: EvalCounterStore,
    private readonly subscriber: TopicSubscriber,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    shutdown?.register({
      name: 'flags.client.close',
      order: 85,
      run: () => this.onModuleDestroy(),
    });
  }

  async onModuleInit(): Promise<void> {
    const now = this.clock.now().getTime();
    this.scheduleFrom(now);
    // One bounded attempt, then the process starts whatever happened (VIII.3); the ticker retries until a ruleset loads.
    await this.refresh('start').catch(() => false);
    await this.ensureSubscribed();
    this.ticker = setInterval(() => void this.tick(), TICK_MS);
    this.ticker.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.ticker) clearInterval(this.ticker);
    await this.release?.().catch(() => undefined);
    this.release = undefined;
    await this.flushCounts().catch(() => undefined);
  }

  /** True once a ruleset has loaded (from the cache or the database). Before that every evaluation is `ruleset_unavailable`. */
  get ready(): boolean {
    return this.loaded;
  }

  get version(): number {
    return this.ruleset.version;
  }

  evaluate(key: string, ctx: EvalContext): Evaluation {
    const flag = this.byKey.get(key);
    const result = this.loaded
      ? evaluate(flag, ctx, key)
      : rulesetUnavailable(key);
    // Only keys of the ruleset are counted and labelled; a key a caller made up must not grow a store or a label set.
    const label = flag ? key : 'unknown';
    if (flag) this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    const metricKey = `${label}\u0000${result.reason}`;
    this.metricCounts.set(
      metricKey,
      (this.metricCounts.get(metricKey) ?? 0) + 1,
    );
    return result;
  }

  isEnabled(key: string, ctx: EvalContext): boolean {
    return this.evaluate(key, ctx).value === true;
  }

  value<T extends FlagValue>(key: string, ctx: EvalContext, fallback: T): T {
    const result = this.evaluate(key, ctx);
    return result.reason === 'unknown_flag' ||
      result.reason === 'ruleset_unavailable'
      ? fallback
      : (result.value as T);
  }

  /** Keys of the flags a browser may see, in key order. */
  clientSideKeys(): string[] {
    return this.ruleset.flags
      .filter((f) => f.clientSide)
      .map((f) => f.key)
      .sort();
  }

  /** Fetches the ruleset and applies it when newer. Never throws. `push`: the trigger was a notification. */
  refresh(trigger: 'start' | 'push' | 'poll' = 'poll'): Promise<boolean> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const run = (async () => {
      let applied = await this.refreshOnce(trigger);
      while (this.refreshAgain) {
        this.refreshAgain = false;
        applied = (await this.refreshOnce('push')) || applied;
      }
      return applied;
    })().finally(() => {
      this.refreshing = null;
    });
    this.refreshing = run;
    return run;
  }

  /** What is due now (poll, flush, cold-start retry). The 1 s ticker calls it; a spec can call it after moving the clock. */
  async tick(): Promise<void> {
    if (this.destroyed) return;
    const now = this.clock.now().getTime();
    if (this.loaded)
      flagsRulesetAgeSeconds.set(Math.max(0, (now - this.appliedAt) / 1000));
    const due: Promise<unknown>[] = [];
    if (!this.loaded && now >= this.nextRetryAt) {
      this.nextRetryAt = now + COLD_START_RETRY_MS;
      due.push(this.refresh('start'));
    }
    if (now >= this.nextPollAt) {
      this.nextPollAt = now + this.pollDelay();
      if (this.loaded) due.push(this.refresh('poll'));
      due.push(this.ensureSubscribed());
    }
    if (now >= this.nextFlushAt) {
      this.nextFlushAt = now + FLUSH_INTERVAL_MS;
      due.push(this.flushCounts());
    }
    await Promise.allSettled(due);
  }

  /**
   * Moves the in-memory metric counts into the registry and the per-flag counts to the day's counter. A failed flush
   * keeps the counts for the next attempt; only what was written is subtracted.
   */
  async flushCounts(): Promise<void> {
    for (const [metricKey, n] of this.metricCounts) {
      const [flag, reason] = metricKey.split('\u0000');
      flagsEvaluationsTotal.add(n, { flag, reason });
    }
    this.metricCounts.clear();
    if (this.counts.size === 0) return;
    const flushed = Object.fromEntries(this.counts);
    const day = this.clock.now().toISOString().slice(0, 10);
    try {
      await this.store.add(day, flushed);
    } catch (error) {
      this.logger.warn(
        `evaluation counters not flushed (kept for the next attempt): ${(error as Error).message}`,
      );
      return;
    }
    for (const [key, n] of Object.entries(flushed)) {
      const left = (this.counts.get(key) ?? 0) - n;
      if (left > 0) this.counts.set(key, left);
      else this.counts.delete(key);
    }
  }

  private pollDelay(): number {
    return POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
  }

  private scheduleFrom(now: number): void {
    this.nextPollAt = now + this.pollDelay();
    this.nextFlushAt = now + FLUSH_INTERVAL_MS;
    this.nextRetryAt = now + COLD_START_RETRY_MS;
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.release || this.subscribing || this.destroyed) return;
    this.subscribing = true;
    try {
      this.release = await withTimeout(
        this.subscriber.subscribe('flags', (message) =>
          this.onPush(message.data),
        ),
        SUBSCRIBE_TIMEOUT_MS,
        'flags push channel',
      );
    } catch (error) {
      this.logger.warn(
        `flags push channel unavailable, polling only: ${(error as Error).message}`,
      );
    } finally {
      this.subscribing = false;
    }
  }

  /** A push carries only the version: not newer than ours → ignored (counted); otherwise fetch the snapshot now. */
  private onPush(data: unknown): void {
    const pushed = (data as { version?: unknown } | null)?.version;
    if (
      this.loaded &&
      typeof pushed === 'number' &&
      Number.isInteger(pushed) &&
      pushed <= this.ruleset.version
    ) {
      flagsRulesetIgnoredTotal.add(1);
      return;
    }
    void this.refresh('push');
  }

  private async refreshOnce(
    trigger: 'start' | 'push' | 'poll',
  ): Promise<boolean> {
    let snapshot: FlagRulesetSnapshot;
    try {
      snapshot = await this.source.read();
    } catch (error) {
      if (error instanceof InvalidSnapshotError) {
        flagsRulesetRejectedTotal.add(1);
        if (!this.warnedInvalid) {
          this.warnedInvalid = true;
          this.logger.warn(`ruleset snapshot rejected: ${error.message}`);
        }
        if (this.loaded) return false;
        try {
          snapshot = await this.source.readDatabase();
        } catch (dbError) {
          return this.failed(dbError);
        }
      } else return this.failed(error);
    }
    this.warnedInvalid = false;
    return this.apply(snapshot, trigger);
  }

  private failed(error: unknown): boolean {
    flagsRefreshFailuresTotal.add(1);
    this.logger.warn(
      `flags refresh failed (keeping v${this.ruleset.version}${this.loaded ? '' : ', not ready'}): ${(error as Error).message}`,
    );
    return false;
  }

  private apply(
    snapshot: FlagRulesetSnapshot,
    trigger: 'start' | 'push' | 'poll',
  ): boolean {
    if (this.loaded && snapshot.version <= this.ruleset.version) {
      if (trigger === 'push') flagsRulesetIgnoredTotal.add(1);
      return false;
    }
    this.ruleset = snapshot;
    this.byKey = new Map(
      snapshot.flags.map((f) => [f.key, f as SdkFlag & FlagDefinition]),
    );
    this.loaded = true;
    this.appliedAt = this.clock.now().getTime();
    flagsRulesetVersion.set(snapshot.version);
    flagsRulesetAgeSeconds.set(0);
    return true;
  }
}

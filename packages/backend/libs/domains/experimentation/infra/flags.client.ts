import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import Redis from 'ioredis';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle/shutdown-registry.service';
import { channelName } from '@app/infrastructure/realtime/topics';
import { EvalContext, Evaluation, evaluate, FlagDefinition, FlagValue } from '../domain/evaluator';

export const RULESET_KEY = 'flags:ruleset';
export const RULESET_CHANNEL = channelName('flags');
const POLL_MS = 30_000;
const FLUSH_MS = 30_000;
export const evalCountKey = (day: string) => `flags:evals:${day}`;

export interface Ruleset {
  version: number;
  flags: (FlagDefinition & { clientSide: boolean })[];
}

/**
 * Local-evaluation SDK (10/09 #38), one per process:
 *  - the WHOLE ruleset lives in memory; `evaluate()` is a pure function call,
 *    no I/O - so a flag check costs microseconds and keeps working if Redis
 *    and Postgres are both down (last known ruleset);
 *  - updates are pushed (Redis pub/sub on the `flags` realtime channel) and
 *    polled every 30 s as a fallback; only newer versions are applied;
 *  - evaluation counts are aggregated locally and flushed every 30 s
 *    (stale-flag report: "nobody evaluated this in 14 days → delete it").
 */
@Injectable()
export class FlagsClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FlagsClient.name);
  private ruleset: Ruleset = { version: 0, flags: [] };
  private byKey = new Map<string, FlagDefinition & { clientSide: boolean }>();
  private readonly counts = new Map<string, number>();
  private readonly subscriber: Redis;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly redis: RedisService,
    @InjectConnection() private readonly sequelize: Sequelize,
    config: ApiConfigService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    this.subscriber = new Redis(config.get('redis_url'), { maxRetriesPerRequest: null, lazyConnect: true });
    shutdown?.register({ name: 'flags.client.close', order: 85, run: () => this.onModuleDestroy() });
  }

  async onModuleInit() {
    await this.refresh();
    this.subscriber.on('message', () => void this.refresh());
    await this.subscriber.connect().then(() => this.subscriber.subscribe(RULESET_CHANNEL)).catch((e) => this.logger.warn(`flags push channel unavailable, polling only: ${e.message}`));
    this.timers = [setInterval(() => void this.refresh(), POLL_MS), setInterval(() => void this.flushCounts(), FLUSH_MS)];
    this.timers.forEach((t) => t.unref());
  }

  async onModuleDestroy() {
    this.timers.forEach(clearInterval);
    await this.flushCounts();
    this.subscriber.disconnect();
  }

  get version(): number {
    return this.ruleset.version;
  }

  evaluate(key: string, ctx: EvalContext): Evaluation {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    const result = evaluate(this.byKey.get(key), ctx);
    return result.reason === 'unknown_flag' ? { ...result, key } : result;
  }

  isEnabled(key: string, ctx: EvalContext): boolean {
    return this.evaluate(key, ctx).value === true;
  }

  value<T extends FlagValue>(key: string, ctx: EvalContext, fallback: T): T {
    const result = this.evaluate(key, ctx);
    return result.reason === 'unknown_flag' ? fallback : (result.value as T);
  }

  /** Client-side flags, pre-evaluated: browsers get `{key: value}`, never the targeting rules. */
  evaluateClientFlags(ctx: EvalContext): Record<string, FlagValue> {
    return Object.fromEntries(this.ruleset.flags.filter((f) => f.clientSide).map((f) => [f.key, this.evaluate(f.key, ctx).value]));
  }

  async refresh(): Promise<boolean> {
    try {
      const raw = await this.redis.client.get(RULESET_KEY);
      // Cold start with nothing published yet: read Postgres once (version 0, so any published ruleset supersedes it).
      const next: Ruleset | null = raw ? (JSON.parse(raw) as Ruleset) : this.ruleset.flags.length === 0 ? await this.loadFromDb() : null;
      if (!next || (next.version <= this.ruleset.version && !(next.version === 0 && this.ruleset.flags.length === 0))) return false;
      this.ruleset = next;
      this.byKey = new Map(next.flags.map((f) => [f.key, f]));
      return true;
    } catch (error) {
      this.logger.warn(`flags refresh failed (keeping v${this.ruleset.version}): ${(error as Error).message}`);
      return false;
    }
  }

  private async loadFromDb(): Promise<Ruleset | null> {
    const flags = await loadFlags(this.sequelize);
    return flags.length ? { version: 0, flags } : null;
  }

  private async flushCounts() {
    if (this.counts.size === 0) return;
    const day = new Date().toISOString().slice(0, 10);
    const pipeline = this.redis.client.pipeline();
    for (const [key, n] of this.counts) pipeline.hincrby(evalCountKey(day), key, n);
    pipeline.expire(evalCountKey(day), 40 * 86_400);
    this.counts.clear();
    await pipeline.exec().catch(() => undefined);
  }
}

export async function loadFlags(sequelize: Sequelize): Promise<(FlagDefinition & { clientSide: boolean })[]> {
  return sequelize.query(
    `SELECT key, enabled, variants, "defaultVariant", "offVariant", rules, "bucketBy", version, "clientSide" FROM "FeatureFlag"`,
    { type: QueryTypes.SELECT },
  );
}

import { Inject, Injectable } from '@nestjs/common';
import {
  flagRulesetSnapshotSchema,
  type FlagRulesetSnapshot,
} from '@marketplace-sandbox/contracts';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  FLAG_REPOSITORY,
  InvalidSnapshotError,
  type FlagRepository,
  type RulesetSource,
} from '../domain/ports';
import { RULESET_KEY } from './redis-keys';
import { withTimeout } from '../domain/with-timeout';

export const CACHE_READ_TIMEOUT_MS = 500;
export const DATABASE_READ_TIMEOUT_MS = 2_000;

const parse = (raw: unknown): FlagRulesetSnapshot => {
  const parsed = flagRulesetSnapshotSchema.safeParse(raw);
  if (!parsed.success)
    throw new InvalidSnapshotError(
      [
        ...new Set(
          parsed.error.issues.map((i) => i.path.join('.') || '(root)'),
        ),
      ].join(', '),
    );
  return parsed.data;
};

/**
 * Where an SDK reads the ruleset: the shared cache first (500 ms), then the primary database (2 s). A missing, failing
 * or slow cache falls through to the database every time, not only at start (G9); a cache entry that is not a valid
 * snapshot is the caller's to count and refuse (`InvalidSnapshotError`).
 */
@Injectable()
export class RedisRulesetSource implements RulesetSource {
  constructor(
    private readonly redis: RedisService,
    @Inject(FLAG_REPOSITORY) private readonly flags: FlagRepository,
  ) {}

  async read(): Promise<FlagRulesetSnapshot> {
    let raw: string | null = null;
    try {
      raw = await withTimeout(
        this.redis.client.get(RULESET_KEY),
        CACHE_READ_TIMEOUT_MS,
        'ruleset cache',
      );
    } catch {
      return this.readDatabase();
    }
    if (raw === null) return this.readDatabase();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new InvalidSnapshotError('not JSON');
    }
    return parse(json);
  }

  async readDatabase(): Promise<FlagRulesetSnapshot> {
    return parse(
      await withTimeout(
        this.flags.loadSnapshot(),
        DATABASE_READ_TIMEOUT_MS,
        'ruleset database',
      ),
    );
  }
}

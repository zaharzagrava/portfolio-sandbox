import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { FlagDefinition, validateFlag } from '../domain/evaluator';
import { evalCountKey, loadFlags, RULESET_CHANNEL, RULESET_KEY } from '../infra/flags.client';

export interface FlagInput extends Omit<FlagDefinition, 'version' | 'key'> {
  description?: string;
  owner: string;
  clientSide?: boolean;
  expiresAt?: string | null;
}

/** Only replace the published ruleset with a NEWER one (two admins saving at once can't publish out of order). */
const PUBLISH_IF_NEWER = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local v = cjson.decode(cur)['version']
  if v and v >= tonumber(ARGV[2]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('PUBLISH', KEYS[2], ARGV[2])
return 1`;

@Injectable()
export class FlagsAdminService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly redis: RedisService,
  ) {}

  list() {
    return this.sequelize.query(`SELECT * FROM "FeatureFlag" ORDER BY key`, { type: QueryTypes.SELECT });
  }

  async upsert(key: string, input: FlagInput, actorId: string) {
    const errors = validateFlag({ key, ...input });
    if (errors.length) throw new BadRequestException({ message: 'Invalid flag', errors });
    await this.sequelize.transaction(async (transaction) => {
      const [before] = await this.sequelize.query(`SELECT * FROM "FeatureFlag" WHERE key = :key FOR UPDATE`, { type: QueryTypes.SELECT, replacements: { key }, transaction });
      const [after] = await this.sequelize.query(
        `INSERT INTO "FeatureFlag" (key, description, enabled, variants, "defaultVariant", "offVariant", rules, "bucketBy", owner, "clientSide", "expiresAt")
         VALUES (:key, :description, :enabled, CAST(:variants AS jsonb), :defaultVariant, :offVariant, CAST(:rules AS jsonb), :bucketBy, :owner, :clientSide, :expiresAt)
         ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, enabled = EXCLUDED.enabled, variants = EXCLUDED.variants,
           "defaultVariant" = EXCLUDED."defaultVariant", "offVariant" = EXCLUDED."offVariant", rules = EXCLUDED.rules, "bucketBy" = EXCLUDED."bucketBy",
           owner = EXCLUDED.owner, "clientSide" = EXCLUDED."clientSide", "expiresAt" = EXCLUDED."expiresAt", version = "FeatureFlag".version + 1, "updatedAt" = now()
         RETURNING *`,
        {
          type: QueryTypes.SELECT,
          replacements: {
            key,
            description: input.description ?? '',
            enabled: input.enabled,
            variants: JSON.stringify(input.variants),
            defaultVariant: input.defaultVariant,
            offVariant: input.offVariant,
            rules: JSON.stringify(input.rules),
            bucketBy: input.bucketBy || 'userId',
            owner: input.owner,
            clientSide: input.clientSide ?? false,
            expiresAt: input.expiresAt ?? null,
          },
          transaction,
        },
      );
      await this.audit(key, actorId, before ? 'update' : 'create', before ?? null, after, transaction);
    });
    await this.publish();
    return this.get(key);
  }

  /** Kill switch: one call, propagated to every process within ~1 s via push. */
  async kill(key: string, actorId: string) {
    await this.sequelize.transaction(async (transaction) => {
      const [before] = await this.sequelize.query(`SELECT * FROM "FeatureFlag" WHERE key = :key FOR UPDATE`, { type: QueryTypes.SELECT, replacements: { key }, transaction });
      if (!before) throw new NotFoundException('Unknown flag');
      const [after] = await this.sequelize.query(`UPDATE "FeatureFlag" SET enabled = false, version = version + 1, "updatedAt" = now() WHERE key = :key RETURNING *`, {
        type: QueryTypes.SELECT,
        replacements: { key },
        transaction,
      });
      await this.audit(key, actorId, 'kill', before, after, transaction);
    });
    await this.publish();
  }

  async get(key: string) {
    const [flag] = await this.sequelize.query(`SELECT * FROM "FeatureFlag" WHERE key = :key`, { type: QueryTypes.SELECT, replacements: { key } });
    if (!flag) throw new NotFoundException('Unknown flag');
    return flag;
  }

  history(key: string) {
    return this.sequelize.query(`SELECT "actorId", action, before, after, at FROM "FlagAudit" WHERE "flagKey" = :key ORDER BY at DESC LIMIT 100`, { type: QueryTypes.SELECT, replacements: { key } });
  }

  /** Flags are tech debt: expired ones, and ones nobody evaluated in 14 days. */
  async stale(days = 14) {
    const flags = await this.sequelize.query<{ key: string; owner: string; expiresAt: string | null; updatedAt: string }>(`SELECT key, owner, "expiresAt", "updatedAt" FROM "FeatureFlag"`, { type: QueryTypes.SELECT });
    const pipeline = this.redis.client.pipeline();
    for (let i = 0; i < days; i++) pipeline.hgetall(evalCountKey(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)));
    const totals = new Map<string, number>();
    for (const [, counts] of (await pipeline.exec()) ?? []) for (const [k, n] of Object.entries((counts ?? {}) as Record<string, string>)) totals.set(k, (totals.get(k) ?? 0) + Number(n));
    return flags
      .map((f) => ({ ...f, evaluations: totals.get(f.key) ?? 0, expired: !!f.expiresAt && Date.parse(f.expiresAt) < Date.now() }))
      .filter((f) => f.expired || f.evaluations === 0);
  }

  /** Build the full snapshot AFTER commit and publish it with a monotonically increasing version. */
  async publish(): Promise<number> {
    const version = await this.redis.client.incr('flags:ruleset-version');
    const flags = await loadFlags(this.sequelize);
    await this.redis.client.eval(PUBLISH_IF_NEWER, 2, RULESET_KEY, RULESET_CHANNEL, JSON.stringify({ version, flags }), version);
    return version;
  }

  private audit(flagKey: string, actorId: string, action: string, before: object | null, after: object, transaction: import('sequelize').Transaction) {
    return this.sequelize.query(`INSERT INTO "FlagAudit" ("flagKey", "actorId", action, before, after) VALUES (:flagKey, :actorId, :action, CAST(:before AS jsonb), CAST(:after AS jsonb))`, {
      replacements: { flagKey, actorId, action, before: before ? JSON.stringify(before) : null, after: JSON.stringify(after) },
      transaction,
    });
  }
}

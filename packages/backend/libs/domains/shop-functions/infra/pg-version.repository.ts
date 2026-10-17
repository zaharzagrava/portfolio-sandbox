import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import type { VersionStatus } from '@marketplace-sandbox/contracts';
import type { TestCase, VerdictRecord } from '../domain/contract';
import { decodeVersionCursor, encodeVersionCursor } from '../domain/cursor';
import { StaleStateError, versionLimitReached } from '../domain/errors';
import type {
  ActivateOutcome,
  JudgeApplied,
  JudgeClaim,
  KeysetPage,
  TimelineEntry,
  VersionRecord,
  VersionRepository,
} from '../domain/ports';
import { transition, type VersionState } from '../domain/version-state';

const COLUMNS = `v."functionId", v."version", v."source", v."sourceHash", v."status", v."verdicts", v."rejectionReason",
  v."judgeAttempts", v."createdBy", v."createdAt", v."updatedAt", v."judgedAt"`;

const passedAll = (verdicts: VerdictRecord[] | null) =>
  !!verdicts &&
  verdicts.length > 0 &&
  verdicts.every((v) => v.verdict === 'pass');

const stateOf = (row: {
  status: VersionStatus;
  verdicts: VerdictRecord[] | null;
}): VersionState =>
  row.status === 'SUPERSEDED'
    ? { status: 'SUPERSEDED', passed: passedAll(row.verdicts) }
    : ({ status: row.status } as VersionState);

/** `ShopFunctionVersion` rows and their history. Every status change is a conditional update asserting one row, plus a history row. */
@Injectable()
export class PgVersionRepository implements VersionRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements,
    });
  }

  private async exec(sql: string, replacements: Record<string, unknown>) {
    await this.sequelize.query(sql, { replacements });
  }

  private history(args: {
    functionId: string;
    version: number;
    from: VersionStatus | null;
    to: VersionStatus;
    actorId: string | null;
    reason: string | null;
    now: Date;
  }) {
    return this.exec(
      `INSERT INTO "ShopFunctionVersionHistory" ("functionId", "version", "fromStatus", "toStatus", "actorId", "reason", "at")
       VALUES (:functionId, :version, :from, :to, :actorId, :reason, :now)`,
      args,
    );
  }

  /** `UPDATE … WHERE status = :from`, asserting that exactly one row changed. */
  private async move(args: {
    functionId: string;
    version: number;
    from: VersionStatus;
    to: VersionStatus;
    now: Date;
    verdicts?: VerdictRecord[];
    judged?: boolean;
  }) {
    const rows = await this.select<{ version: number }>(
      `UPDATE "ShopFunctionVersion" SET "status" = :to, "updatedAt" = :now,
         "verdicts" = COALESCE(CAST(:verdicts AS jsonb), "verdicts"),
         "judgedAt" = CASE WHEN :judged THEN :now ELSE "judgedAt" END
       WHERE "functionId" = :functionId AND "version" = :version AND "status" = :from RETURNING "version"`,
      {
        ...args,
        verdicts: args.verdicts ? JSON.stringify(args.verdicts) : null,
        judged: args.judged ?? false,
      },
    );
    if (rows.length !== 1)
      throw new StaleStateError(`${args.from} -> ${args.to}`);
  }

  async submit(args: Parameters<VersionRepository['submit']>[0]) {
    const [fn] = await this.select<{ id: string }>(
      `SELECT "id" FROM "ShopFunction" WHERE "id" = :functionId AND "shopId" = :shopId FOR UPDATE`,
      args,
    );
    if (!fn) return null;
    const [stats] = await this.select<{ n: number; latest: number }>(
      `SELECT COUNT(*)::int AS n, COALESCE(MAX("version"), 0)::int AS latest
       FROM "ShopFunctionVersion" WHERE "functionId" = :functionId`,
      args,
    );
    if (stats.n >= args.maxVersions)
      throw versionLimitReached(args.maxVersions);
    const version = stats.latest + 1;
    await this.exec(
      `INSERT INTO "ShopFunctionVersion" ("functionId", "version", "source", "sourceHash", "status", "createdBy", "createdAt", "updatedAt")
       VALUES (:functionId, :version, :source, :sourceHash, 'QUEUED', :userId, :now, :now)`,
      { ...args, version },
    );
    await this.exec(
      `INSERT INTO "ShopFunctionTestCase" ("functionId", "version", "name", "input", "expected")
       SELECT "functionId", :version, "name", "input", "expected" FROM "ShopFunctionTestCase"
       WHERE "functionId" = :functionId AND "version" IS NULL ORDER BY "id"`,
      { functionId: args.functionId, version },
    );
    await this.history({
      functionId: args.functionId,
      version,
      from: null,
      to: 'QUEUED',
      actorId: args.userId,
      reason: null,
      now: args.now,
    });
    return { version, createdAt: args.now };
  }

  async list(
    shopId: string,
    functionId: string,
    limit: number,
    cursor: string | null,
  ): Promise<KeysetPage<VersionRecord> | null> {
    const after = cursor ? decodeVersionCursor(cursor) : null;
    const owned = await this.select<{ id: string }>(
      `SELECT "id" FROM "ShopFunction" WHERE "id" = :functionId AND "shopId" = :shopId`,
      { shopId, functionId },
    );
    if (owned.length === 0) return null;
    const rows = await this.select<VersionRecord>(
      `SELECT ${COLUMNS} FROM "ShopFunctionVersion" v WHERE v."functionId" = :functionId
         ${after ? 'AND v."version" < :after' : ''} ORDER BY v."version" DESC LIMIT :limit`,
      { functionId, after, limit: limit + 1 },
    );
    const page = rows.slice(0, limit);
    return {
      items: page,
      nextCursor:
        rows.length > limit
          ? encodeVersionCursor(page[page.length - 1].version)
          : null,
    };
  }

  async get(shopId: string, functionId: string, version: number) {
    const [row] = await this.select<VersionRecord>(
      `SELECT ${COLUMNS} FROM "ShopFunctionVersion" v JOIN "ShopFunction" f ON f."id" = v."functionId"
       WHERE f."shopId" = :shopId AND v."functionId" = :functionId AND v."version" = :version`,
      { shopId, functionId, version },
    );
    return row ?? null;
  }

  async timeline(
    functionId: string,
    version: number,
  ): Promise<TimelineEntry[]> {
    const rows = await this.select<{
      toStatus: VersionStatus;
      at: Date;
      actorId: string | null;
      reason: string | null;
    }>(
      `SELECT "toStatus", "at", "actorId", "reason" FROM "ShopFunctionVersionHistory"
       WHERE "functionId" = :functionId AND "version" = :version ORDER BY "at", "id"`,
      { functionId, version },
    );
    return rows.map((r) => ({
      status: r.toStatus,
      at: r.at,
      actorId: r.actorId,
      reason: r.reason,
    }));
  }

  async activate(args: {
    shopId: string;
    functionId: string;
    version: number;
    actorId: string;
    now: Date;
  }): Promise<ActivateOutcome> {
    const [fn] = await this.select<{
      id: string;
      activeVersion: number | null;
    }>(
      `SELECT "id", "activeVersion" FROM "ShopFunction" WHERE "id" = :functionId AND "shopId" = :shopId FOR UPDATE`,
      args,
    );
    if (!fn) return 'not_found';
    const [row] = await this.select<{
      status: VersionStatus;
      verdicts: VerdictRecord[] | null;
    }>(
      `SELECT "status", "verdicts" FROM "ShopFunctionVersion" WHERE "functionId" = :functionId AND "version" = :version FOR UPDATE`,
      args,
    );
    if (!row) return 'not_found';
    if (!transition(stateOf(row), { type: 'rollback' }))
      return 'not_activatable';
    if (fn.activeVersion !== null) {
      await this.move({
        functionId: args.functionId,
        version: fn.activeVersion,
        from: 'ACTIVE',
        to: 'SUPERSEDED',
        now: args.now,
      });
      await this.history({
        functionId: args.functionId,
        version: fn.activeVersion,
        from: 'ACTIVE',
        to: 'SUPERSEDED',
        actorId: args.actorId,
        reason: null,
        now: args.now,
      });
    }
    await this.move({
      functionId: args.functionId,
      version: args.version,
      from: 'SUPERSEDED',
      to: 'ACTIVE',
      now: args.now,
    });
    await this.history({
      functionId: args.functionId,
      version: args.version,
      from: 'SUPERSEDED',
      to: 'ACTIVE',
      actorId: args.actorId,
      reason: 'rollback',
      now: args.now,
    });
    await this.exec(
      `UPDATE "ShopFunction" SET "activeVersion" = :version, "updatedAt" = now() WHERE "id" = :functionId`,
      args,
    );
    return 'activated';
  }

  async claimForJudge(
    functionId: string,
    version: number,
    now: Date,
  ): Promise<JudgeClaim | null> {
    const claimed = await this.select<{ source: string }>(
      `UPDATE "ShopFunctionVersion" SET "status" = 'TESTING', "updatedAt" = :now
       WHERE "functionId" = :functionId AND "version" = :version AND "status" = 'QUEUED' RETURNING "source"`,
      { functionId, version, now },
    );
    let source: string;
    if (claimed.length === 1) {
      source = claimed[0].source;
      await this.history({
        functionId,
        version,
        from: 'QUEUED',
        to: 'TESTING',
        actorId: null,
        reason: null,
        now,
      });
    } else {
      // A crashed worker left it TESTING: judge again, without a second transition.
      const again = await this.select<{ source: string }>(
        `UPDATE "ShopFunctionVersion" SET "updatedAt" = :now
         WHERE "functionId" = :functionId AND "version" = :version AND "status" = 'TESTING' RETURNING "source"`,
        { functionId, version, now },
      );
      if (again.length !== 1) return null;
      source = again[0].source;
    }
    const [fn] = await this.select<{ shopId: string }>(
      `SELECT "shopId" FROM "ShopFunction" WHERE "id" = :functionId`,
      { functionId },
    );
    if (!fn) return null;
    const cases = await this.select<TestCase>(
      `SELECT "name", "input", "expected" FROM "ShopFunctionTestCase"
       WHERE "functionId" = :functionId AND "version" = :version ORDER BY "name" COLLATE "C"`,
      { functionId, version },
    );
    return { shopId: fn.shopId, source, cases };
  }

  async applyJudgeResult(args: {
    functionId: string;
    version: number;
    verdicts: VerdictRecord[];
    passed: boolean;
    now: Date;
  }): Promise<JudgeApplied> {
    const [fn] = await this.select<{
      shopId: string;
      activeVersion: number | null;
    }>(
      `SELECT "shopId", "activeVersion" FROM "ShopFunction" WHERE "id" = :functionId FOR UPDATE`,
      args,
    );
    if (!fn) return { outcome: 'noop' };
    const [row] = await this.select<{ status: VersionStatus }>(
      `SELECT "status" FROM "ShopFunctionVersion" WHERE "functionId" = :functionId AND "version" = :version FOR UPDATE`,
      args,
    );
    if (!row || row.status !== 'TESTING') return { outcome: 'noop' };
    const newer = fn.activeVersion === null || args.version > fn.activeVersion;
    const t = transition(
      { status: 'TESTING' },
      args.passed
        ? { type: 'passed', newerThanActive: newer }
        : { type: 'failed' },
    );
    if (!t) return { outcome: 'noop' };
    const base = { functionId: args.functionId, now: args.now };
    if (t.to.status === 'ACTIVE' && fn.activeVersion !== null) {
      await this.move({
        ...base,
        version: fn.activeVersion,
        from: 'ACTIVE',
        to: 'SUPERSEDED',
      });
      await this.history({
        ...base,
        version: fn.activeVersion,
        from: 'ACTIVE',
        to: 'SUPERSEDED',
        actorId: null,
        reason: null,
      });
    }
    await this.move({
      ...base,
      version: args.version,
      from: 'TESTING',
      to: t.to.status,
      verdicts: args.verdicts,
      judged: true,
    });
    await this.history({
      ...base,
      version: args.version,
      from: 'TESTING',
      to: t.to.status,
      actorId: null,
      reason: t.reason,
    });
    if (t.to.status === 'ACTIVE')
      await this.exec(
        `UPDATE "ShopFunction" SET "activeVersion" = :version, "updatedAt" = now() WHERE "id" = :functionId`,
        args,
      );
    return {
      outcome:
        t.to.status === 'ACTIVE'
          ? 'active'
          : t.to.status === 'SUPERSEDED'
            ? 'superseded'
            : 'rejected',
      shopId: fn.shopId,
    };
  }

  findStuck(before: Date, limit: number) {
    return this.select<{
      functionId: string;
      version: number;
      judgeAttempts: number;
      updatedAt: Date;
    }>(
      `SELECT "functionId", "version", "judgeAttempts", "updatedAt" FROM "ShopFunctionVersion"
       WHERE "status" IN ('QUEUED', 'TESTING') AND "updatedAt" < :before ORDER BY "updatedAt", "functionId", "version" LIMIT :limit`,
      { before, limit },
    );
  }

  async rerequest(
    functionId: string,
    version: number,
    seenAttempts: number,
    before: Date,
    now: Date,
  ) {
    const rows = await this.select<{ version: number }>(
      `UPDATE "ShopFunctionVersion" SET "judgeAttempts" = "judgeAttempts" + 1, "updatedAt" = :now
       WHERE "functionId" = :functionId AND "version" = :version AND "status" IN ('QUEUED', 'TESTING')
         AND "updatedAt" < :before AND "judgeAttempts" = :seenAttempts RETURNING "version"`,
      { functionId, version, seenAttempts, before, now },
    );
    return rows.length === 1;
  }

  async exhaust(functionId: string, version: number, before: Date, now: Date) {
    const [row] = await this.select<{ status: VersionStatus; shopId: string }>(
      `SELECT v."status", f."shopId" FROM "ShopFunctionVersion" v JOIN "ShopFunction" f ON f."id" = v."functionId"
       WHERE v."functionId" = :functionId AND v."version" = :version AND v."status" IN ('QUEUED', 'TESTING')
         AND v."updatedAt" < :before FOR UPDATE OF v`,
      { functionId, version, before },
    );
    if (!row) return null;
    const t = transition({ status: row.status } as VersionState, {
      type: 'attemptsExhausted',
    });
    if (!t) return null;
    await this.exec(
      `UPDATE "ShopFunctionVersion" SET "status" = 'REJECTED', "rejectionReason" = 'judge_unavailable', "judgedAt" = :now, "updatedAt" = :now
       WHERE "functionId" = :functionId AND "version" = :version AND "status" = :from`,
      { functionId, version, now, from: row.status },
    );
    await this.history({
      functionId,
      version,
      from: row.status,
      to: 'REJECTED',
      actorId: null,
      reason: t.reason,
      now,
    });
    return { shopId: row.shopId };
  }

  async backlog(now: Date) {
    const [row] = await this.select<{ n: number; oldest: number | null }>(
      `SELECT COUNT(*)::int AS n, EXTRACT(EPOCH FROM (CAST(:now AS timestamptz) - MIN("createdAt")))::float8 AS oldest
       FROM "ShopFunctionVersion" WHERE "status" = 'QUEUED'`,
      { now },
    );
    return {
      count: row.n,
      oldestAgeSeconds: row.oldest === null ? 0 : Math.max(0, row.oldest),
    };
  }
}

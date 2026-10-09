import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { JobRow } from './job-types';

/** What the worker offers to run: one entry per type it has a handler for and a free local slot. */
export interface ClaimableType {
  type: string;
  leaseMs: number;
  /** Free slots of this type on this worker (the per-instance bulkhead). */
  room: number;
  /** Most RUNNING jobs of this type across the fleet; undefined = unlimited. */
  fleetConcurrency?: number;
}

export interface ClaimParams {
  workerId: string;
  now: Date;
  limit: number;
  types: ClaimableType[];
  /** Most RUNNING jobs per shop across the fleet. */
  shopCap: number;
}

interface Candidate {
  id: string;
  createdAt: string;
  type: string;
  shopId: string | null;
}

/** Candidates read per claim, as a multiple of the batch: room to step over shops that are at their cap (R-01). */
const OVER_FETCH = 4;
const CLAIM_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * The candidate read of a claim: bind $1 now, $2 types, $3 shops at their cap, $4 limit. Served by the partial index on
 * `runAt` of QUEUED rows, so its cost does not grow with the history of finished jobs (FR-050). Exported so a spec can
 * look at its plan.
 */
export const CANDIDATE_SQL = `SELECT id, "createdAt"::text AS "createdAt", type, "shopId" FROM "Job"
  WHERE status = 'QUEUED' AND "runAt" <= $1 AND type = ANY($2::text[])
    AND ("shopId" IS NULL OR NOT ("shopId" = ANY($3::uuid[])))
  ORDER BY "runAt", id
  LIMIT $4
  FOR UPDATE SKIP LOCKED`;

const sortedUnique = (values: string[]): string[] =>
  [...new Set(values)].sort();

/**
 * Claims up to `limit` due jobs in one short transaction (R-01, R-02, R-04):
 *  1. read candidates oldest-first with `FOR UPDATE SKIP LOCKED` (concurrent claimers never see the same row), leaving
 *     out shops and types already known to be at their limit so a saturated shop cannot hide the others;
 *  2. take transaction-scoped advisory locks, in one global order, for every shop and fleet-limited type among the
 *     candidates: the count-then-update below is then no longer check-then-write between claimers;
 *  3. recount RUNNING per shop and per fleet-limited type under the locks, keep candidates while every limit still holds
 *     (including the rows kept earlier in this same batch);
 *  4. mark the kept rows RUNNING with `lockedUntil = now + that type's lease` and `attempts + 1`.
 * The lease is set here, so no second statement has to extend it.
 */
export async function claimJobs(
  sequelize: Sequelize,
  runner: TransactionRunner,
  params: ClaimParams,
): Promise<JobRow[]> {
  const types = params.types.filter((t) => t.room > 0);
  if (types.length === 0 || params.limit <= 0) return [];
  return runner.run(
    (tx) => claimInTransaction(sequelize, tx, { ...params, types }),
    {
      propagation: 'requires_new',
      statementTimeoutMs: CLAIM_STATEMENT_TIMEOUT_MS,
    },
  );
}

async function claimInTransaction(
  sequelize: Sequelize,
  tx: Transaction,
  params: ClaimParams,
): Promise<JobRow[]> {
  const select = <R extends object>(sql: string, bind: unknown[]) =>
    sequelize.query<R>(sql, { type: QueryTypes.SELECT, bind, transaction: tx });
  const byType = new Map(params.types.map((t) => [t.type, t]));
  const fleetTypes = params.types
    .filter((t) => t.fleetConcurrency !== undefined)
    .map((t) => t.type);

  // Pre-filters (approximate, no locks): stop shops and types that are full from filling the candidate window.
  const fullTypes = new Set<string>();
  if (fleetTypes.length > 0) {
    const running = await select<{ type: string; n: number }>(
      `SELECT type, count(*)::int AS n FROM "Job"
       WHERE status = 'RUNNING' AND type = ANY($1::text[]) GROUP BY type`,
      [fleetTypes],
    );
    for (const { type, n } of running)
      if (n >= (byType.get(type)?.fleetConcurrency ?? Infinity))
        fullTypes.add(type);
  }
  const candidateTypes = params.types
    .map((t) => t.type)
    .filter((t) => !fullTypes.has(t));
  if (candidateTypes.length === 0) return [];

  const saturatedShops = (
    await select<{ shopId: string }>(
      `SELECT "shopId" FROM "Job" WHERE status = 'RUNNING' AND "shopId" IS NOT NULL
       GROUP BY "shopId" HAVING count(*) >= $1`,
      [params.shopCap],
    )
  ).map((r) => r.shopId);

  const candidates = await select<Candidate>(CANDIDATE_SQL, [
    params.now,
    candidateTypes,
    saturatedShops,
    params.limit * OVER_FETCH,
  ]);
  if (candidates.length === 0) return [];

  // Locks: shops and fleet-limited types of the candidates, hashed and taken in ascending key order by every claimer.
  const lockNames = sortedUnique([
    ...candidates
      .filter((c) => c.shopId !== null)
      .map((c) => `job-shop:${c.shopId}`),
    ...candidates
      .filter((c) => byType.get(c.type)?.fleetConcurrency !== undefined)
      .map((c) => `job-type:${c.type}`),
  ]);
  if (lockNames.length > 0)
    await select(
      `SELECT pg_advisory_xact_lock(k) FROM
         (SELECT hashtextextended(s, 0) AS k FROM unnest($1::text[]) AS s ORDER BY 1 OFFSET 0) AS locks`,
      [lockNames],
    );

  const shopIds = sortedUnique(
    candidates.flatMap((c) => (c.shopId === null ? [] : [c.shopId])),
  );
  const runningByShop = new Map<string, number>();
  if (shopIds.length > 0)
    for (const { shopId, n } of await select<{ shopId: string; n: number }>(
      `SELECT "shopId", count(*)::int AS n FROM "Job"
       WHERE status = 'RUNNING' AND "shopId" = ANY($1::uuid[]) GROUP BY "shopId"`,
      [shopIds],
    ))
      runningByShop.set(shopId, n);
  const runningByType = new Map<string, number>();
  if (fleetTypes.length > 0)
    for (const { type, n } of await select<{ type: string; n: number }>(
      `SELECT type, count(*)::int AS n FROM "Job"
       WHERE status = 'RUNNING' AND type = ANY($1::text[]) GROUP BY type`,
      [fleetTypes],
    ))
      runningByType.set(type, n);

  const kept: Candidate[] = [];
  const keptByType = new Map<string, number>();
  const keptByShop = new Map<string, number>();
  for (const c of candidates) {
    if (kept.length >= params.limit) break;
    const spec = byType.get(c.type)!;
    const typeCount = keptByType.get(c.type) ?? 0;
    if (typeCount >= spec.room) continue;
    if (
      spec.fleetConcurrency !== undefined &&
      (runningByType.get(c.type) ?? 0) + typeCount >= spec.fleetConcurrency
    )
      continue;
    if (c.shopId !== null) {
      const shopCount = keptByShop.get(c.shopId) ?? 0;
      if ((runningByShop.get(c.shopId) ?? 0) + shopCount >= params.shopCap)
        continue;
      keptByShop.set(c.shopId, shopCount + 1);
    }
    keptByType.set(c.type, typeCount + 1);
    kept.push(c);
  }
  if (kept.length === 0) return [];

  return select<JobRow>(
    `UPDATE "Job" j
     SET status = 'RUNNING', "lockedBy" = $1, attempts = j.attempts + 1,
         "lockedUntil" = $2::timestamptz + c.lease_ms * interval '1 millisecond'
     FROM unnest($3::uuid[], $4::timestamptz[], $5::int[]) AS c(id, created_at, lease_ms)
     WHERE j.id = c.id AND j."createdAt" = c.created_at AND j.status = 'QUEUED'
     RETURNING j.id, j.type, j.payload, j.status, j."runAt", j.attempts, j."maxAttempts", j."shopId",
       j."enqueuedByRequestId", j.traceparent,
       -- as text: a JS Date keeps only milliseconds, and the later "createdAt" matches need microseconds
       j."createdAt"::text AS "createdAt"`,
    [
      params.workerId,
      params.now,
      kept.map((c) => c.id),
      kept.map((c) => c.createdAt),
      kept.map((c) => byType.get(c.type)!.leaseMs),
    ],
  );
}

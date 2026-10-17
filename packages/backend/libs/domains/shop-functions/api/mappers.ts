import type {
  ShopFunctionDto,
  ShopFunctionVersionDto,
} from '@marketplace-sandbox/contracts';
import type { FunctionWithBreaker } from '../application/functions.service';
import type { TimelineEntry, VersionRecord } from '../domain/ports';

const iso = (d: Date) => new Date(d).toISOString();

/** Response mappers: an ORM row or a record is never serialised as it is (V.1). */
export function toFunctionDto({
  function: fn,
  breaker,
}: FunctionWithBreaker): ShopFunctionDto {
  return {
    id: fn.id,
    shopId: fn.shopId,
    name: fn.name,
    enabled: fn.enabled,
    activeVersion: fn.activeVersion,
    latestVersion: fn.latestVersion,
    testCount: fn.testCount,
    breaker: {
      state: breaker.state,
      openUntil: breaker.openUntil
        ? new Date(breaker.openUntil).toISOString()
        : null,
      lastFailure: breaker.lastFailure
        ? {
            reason: breaker.lastFailure.reason,
            at: new Date(breaker.lastFailure.at).toISOString(),
          }
        : null,
    },
    createdAt: iso(fn.createdAt),
    updatedAt: iso(fn.updatedAt),
  };
}

export function toVersionSummary(v: VersionRecord) {
  return {
    functionId: v.functionId,
    version: v.version,
    status: v.status,
    sourceHash: v.sourceHash,
    verdicts: v.verdicts,
    rejectionReason: v.rejectionReason,
    judgeAttempts: v.judgeAttempts,
    createdBy: v.createdBy,
    createdAt: iso(v.createdAt),
    judgedAt: v.judgedAt ? iso(v.judgedAt) : null,
  };
}

export function toVersionDto(
  v: VersionRecord,
  timeline: TimelineEntry[],
): ShopFunctionVersionDto {
  return {
    ...toVersionSummary(v),
    source: v.source,
    timeline: timeline.map((t) => ({
      status: t.status,
      at: iso(t.at),
      actorId: t.actorId,
      reason: t.reason,
    })),
  };
}

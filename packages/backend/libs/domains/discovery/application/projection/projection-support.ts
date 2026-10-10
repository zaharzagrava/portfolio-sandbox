import {
  ConnectionError,
  ConnectionRefusedError,
  ConnectionTimedOutError,
  TimeoutError,
} from 'sequelize';
import {
  EngineRejectedError,
  EngineUnavailableError,
} from '@app/infrastructure/elasticsearch/search-engine.errors';
import {
  PermanentError,
  TransientError,
} from '@app/infrastructure/projections/errors';
import type { BoostTier } from '../../domain/boost';
import type { ShopStampWrite, ShopStateRecord } from '../../domain/ports';
import { searchProjectionLag } from '../../infra/search-metrics';

/** Maps what the engine client and the database throw onto the consumer framework's retry-or-dead-letter classes. */
export function asProjectionError(error: unknown): unknown {
  if (error instanceof TransientError || error instanceof PermanentError)
    return error;
  if (error instanceof EngineUnavailableError)
    return new TransientError(error.message, { cause: error });
  if (error instanceof EngineRejectedError)
    return new PermanentError(error.message, { cause: error });
  if (
    error instanceof ConnectionError ||
    error instanceof ConnectionRefusedError ||
    error instanceof ConnectionTimedOutError ||
    error instanceof TimeoutError
  )
    return new TransientError(`database unavailable: ${error.message}`, {
      cause: error,
    });
  return error;
}

export async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asProjectionError(error);
  }
}

export const tierOf = (
  plan: ShopStateRecord['plan'],
): BoostTier | null => plan;

/** The stamp a shop-state record puts on documents: hidden unless ACTIVE and not leaving. */
export function stampOf(record: ShopStateRecord): ShopStampWrite {
  return {
    status: record.status,
    hidden: record.status !== 'ACTIVE' || record.offboarding,
    tier: tierOf(record.plan),
    version: record.shopVersion,
    at: record.lastEventAt.toISOString(),
  };
}

export function recordLag(
  source: string,
  occurredAt: string,
  now: Date,
): void {
  const seconds = (now.getTime() - Date.parse(occurredAt)) / 1000;
  if (Number.isFinite(seconds))
    searchProjectionLag.record(Math.max(0, seconds), { source });
}

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

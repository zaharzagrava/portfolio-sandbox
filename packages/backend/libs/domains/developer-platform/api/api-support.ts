import type { IdempotentWireOptions } from '@app/infrastructure/idempotency/idempotent.metadata';
import type { ApiContext } from '../application/api-context';
import { IDEMPOTENCY_KEY_PATTERN } from '../domain/request-rules';
import type { ResourceRequest } from './public-api.interceptor';

/** The public contract's names for the shared idempotency facility (FR-049): its own header, codes and key format. */
export const IDEMPOTENT_WIRE: IdempotentWireOptions = {
  keyPattern: IDEMPOTENCY_KEY_PATTERN,
  invalidKey: { status: 400, code: 'validation_failed' },
  replayHeader: 'Idempotent-Replayed',
  codes: { reuse: 'idempotency_key_reused', inFlight: 'request_in_progress' },
  storeClientErrors: true,
};

/** Who the call acts as: only the verified key says (FR-014). */
export function contextOf(req: ResourceRequest): ApiContext {
  const key = req.apiKey;
  if (!key) throw new Error('route without ApiKeyAuth');
  return {
    shopId: key.shopId,
    liveShopId: key.liveShopId,
    livemode: key.livemode,
    actorId: key.createdBy,
    scopes: key.scopes,
  };
}

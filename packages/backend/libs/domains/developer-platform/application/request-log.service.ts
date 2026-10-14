import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ApiError } from '../domain/errors';
import { RequestLogStore, StoredRequest } from '../domain/ports';

const DAY_MS = 86_400_000;
export const LOG_RETENTION_DAYS = 30;
const DEFAULT_LIMIT = 50;

export interface LogQuery {
  requestId?: string;
  /** `2xx`…`5xx` or one exact status. */
  status?: string;
  route?: string;
  keyId?: string;
  livemode?: boolean;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

const statusRange = (raw: string): { min: number; max: number } => {
  const m = /^([1-5])xx$/.exec(raw);
  if (m) return { min: Number(m[1]) * 100, max: Number(m[1]) * 100 + 99 };
  if (/^[1-5]\d\d$/.test(raw)) return { min: Number(raw), max: Number(raw) };
  throw new ApiError(
    'validation_failed',
    'status must be a class such as 4xx or an exact status.',
    {
      errors: [{ field: 'status', code: 'invalid' }],
    },
  );
};

const toRow = (r: StoredRequest) => ({
  requestId: r.requestId,
  clientRequestId: r.clientRequestId || null,
  keyId: r.keyId,
  livemode: r.livemode,
  version: r.version,
  method: r.method,
  route: r.route,
  status: r.status,
  durationMs: r.durationMs,
  deprecated: r.deprecated,
  errorCode: r.errorCode || null,
  batchOps: r.batchOps,
  idempotentReplay: r.idempotentReplay,
  at: r.at,
});

/**
 * Searches a shop's request log (FR-056, AS-60): every filter is validated, the shop is the one of the route, results are
 * newest first with a keyset cursor `(at, requestId)`. Another shop's request id is just an empty page.
 */
@Injectable()
export class RequestLogService {
  constructor(
    private readonly store: RequestLogStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async search(shopId: string, q: LogQuery) {
    const now = this.clock.now();
    const oldest = new Date(now.getTime() - LOG_RETENTION_DAYS * DAY_MS);
    const from = q.from ?? oldest;
    const to = q.to ?? now;
    if (from.getTime() < oldest.getTime())
      throw new ApiError(
        'validation_failed',
        'from is older than the 30 days kept.',
        {
          errors: [{ field: 'from', code: 'too_old' }],
        },
      );
    if (to.getTime() < from.getTime())
      throw new ApiError('validation_failed', 'to is before from.', {
        errors: [{ field: 'to', code: 'before_from' }],
      });
    const limit = q.limit ?? DEFAULT_LIMIT;
    const after = q.cursor ? this.decode(q.cursor) : null;
    const found = await this.store.search(
      shopId,
      {
        requestId: q.requestId,
        status: q.status ? statusRange(q.status) : undefined,
        route: q.route,
        keyId: q.keyId,
        livemode: q.livemode,
        from,
        to,
      },
      limit + 1,
      after,
    );
    const page = found.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toRow),
      nextCursor:
        found.length > limit && last
          ? Buffer.from(
              JSON.stringify({ v: 1, at: last.at, id: last.requestId }),
            ).toString('base64url')
          : null,
    };
  }

  private decode(raw: string): { at: string; requestId: string } {
    try {
      const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (
        c?.v === 1 &&
        typeof c.at === 'string' &&
        !Number.isNaN(Date.parse(c.at)) &&
        typeof c.id === 'string' &&
        c.id.length <= 128
      )
        return { at: c.at, requestId: c.id };
    } catch {
      // falls through
    }
    throw new ApiError('invalid_cursor', 'The cursor is not valid.');
  }
}

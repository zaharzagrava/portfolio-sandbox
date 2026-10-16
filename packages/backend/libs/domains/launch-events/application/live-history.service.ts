import { Inject, Injectable } from '@nestjs/common';
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  type LiveHistoryPage,
} from '@marketplace-sandbox/contracts';
import { isMinute } from '../domain/live-history-keys';
import {
  liveUnavailable,
  liveValidationFailed,
  streamNotFound,
  type LiveFieldIssue,
} from '../domain/live-errors';
import {
  COMMENT_HISTORY_READER,
  type CommentHistoryReader,
} from '../domain/live-ports';
import { LiveStateCache } from './live-state-cache';

/** `GET /live/:streamId/history` (FR-040): one minute's non-removed comments, paged by a cursor without gaps. */
@Injectable()
export class LiveHistoryService {
  constructor(
    private readonly state: LiveStateCache,
    @Inject(COMMENT_HISTORY_READER)
    private readonly history: CommentHistoryReader,
  ) {}

  async page(
    streamId: string,
    query: { minute?: unknown; limit?: unknown; cursor?: unknown },
  ): Promise<LiveHistoryPage> {
    const issues: LiveFieldIssue[] = [];
    const minute = typeof query.minute === 'string' ? query.minute : '';
    if (!isMinute(minute)) issues.push({ field: 'minute', code: 'invalid' });
    let limit = HISTORY_DEFAULT_LIMIT;
    if (query.limit !== undefined) {
      const raw = query.limit;
      const n =
        typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!(n >= 1 && n <= HISTORY_MAX_LIMIT))
        issues.push({ field: 'limit', code: 'invalid' });
      else limit = n;
    }
    let cursor: string | undefined;
    if (query.cursor !== undefined && query.cursor !== '') {
      if (typeof query.cursor !== 'string' || query.cursor.length > 100)
        issues.push({ field: 'cursor', code: 'invalid' });
      else cursor = query.cursor;
    }
    if (issues.length > 0) throw liveValidationFailed(issues);

    const stream = await this.state.get(streamId);
    if (!stream) throw streamNotFound();
    if (stream.status === 'SCHEDULED') return { items: [], nextCursor: null };
    try {
      return await this.history.page({ streamId, minute, limit, cursor });
    } catch {
      throw liveUnavailable();
    }
  }
}

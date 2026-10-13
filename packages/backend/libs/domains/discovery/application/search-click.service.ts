import { Inject, Injectable } from '@nestjs/common';
import { searchClickRequestSchema } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  SEARCH_EVENT_PUBLISHER,
  type SearchEventPublisher,
} from '../domain/ports';
import { verifySearchId } from '../domain/search-id';
import {
  InvalidSearchIdError,
  SearchValidationError,
} from '../domain/search-errors';
import { SearchSettings } from '../infra/search-settings';

/**
 * A click on a search result (S32 FR-053). Only a search id this service signed within the last 24 hours is accepted:
 * the query that goes into the relevance data is the one the token carries, never one the caller typed. Publishing
 * never fails the call (the adapter counts a dropped event).
 */
@Injectable()
export class SearchClickService {
  constructor(
    @Inject(SEARCH_EVENT_PUBLISHER)
    private readonly events: SearchEventPublisher,
    private readonly settings: SearchSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  record(body: unknown): void {
    const parsed = searchClickRequestSchema.safeParse(body);
    if (!parsed.success) {
      const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
        string,
        unknown
      >;
      const fields = [
        ...new Set(
          parsed.error.issues.flatMap((issue) =>
            issue.code === 'unrecognized_keys'
              ? issue.keys
              : [String(issue.path[0] ?? 'body')],
          ),
        ),
      ];
      // a missing or non-string token is a bad token, not a bad shape (AS-71)
      if (
        fields.length === 1 &&
        fields[0] === 'searchId' &&
        typeof record.searchId !== 'string'
      )
        throw new InvalidSearchIdError();
      throw new SearchValidationError(fields);
    }
    const verdict = verifySearchId(
      this.settings.signingKey,
      parsed.data.searchId,
      this.clock.nowMs(),
    );
    if (!verdict.ok) throw new InvalidSearchIdError();
    this.events.clicked({
      searchId: parsed.data.searchId,
      query: verdict.payload.q,
      productId: parsed.data.productId,
      position: parsed.data.position,
    });
  }
}

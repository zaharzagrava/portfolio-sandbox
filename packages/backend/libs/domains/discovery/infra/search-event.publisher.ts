import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { EventPublisher } from '@app/infrastructure/events/event-publisher';
import { SearchPerformed } from '../application/events/search-query-events';
import { logForm } from '../domain/query-text';
import type {
  SearchEventPublisher,
  SearchPerformedRecord,
} from '../domain/ports';
import { searchEventsDroppedCounter } from './search-metrics';
import { SearchSettings } from './search-settings';

/**
 * Publishes `search.performed` to `search.events`, fire-and-forget: the search never waits for it and a failure is
 * counted (`search_events_dropped_total`), never thrown (FR-052, AS-75). The query goes out normalised and redacted;
 * the caller is only a salted hash (the dedicated `search_log_secret`, never the session secret).
 */
@Injectable()
export class SearchEventPublisherAdapter implements SearchEventPublisher {
  private readonly logger = new Logger(SearchEventPublisherAdapter.name);

  constructor(
    private readonly publisher: EventPublisher,
    private readonly settings: SearchSettings,
  ) {}

  performed(record: SearchPerformedRecord): void {
    try {
      const query = logForm(record.rawQuery);
      if (query === null) return;
      const userHash = createHmac('sha256', this.settings.logSecret)
        .update(record.subject)
        .digest('hex')
        .slice(0, 16);
      const event = SearchPerformed.create(record.searchId, 0, {
        searchId: record.searchId,
        query,
        results: record.results,
        mode: record.mode,
        userHash,
        filters: record.filters,
        degraded: record.degraded,
        surface: record.surface,
      });
      void this.publisher.publish(event).catch((error: Error) => {
        searchEventsDroppedCounter.add(1, { type: 'search.performed' });
        this.logger.warn(`search.performed dropped: ${error.message}`);
      });
    } catch (error) {
      searchEventsDroppedCounter.add(1, { type: 'search.performed' });
      this.logger.warn(`search.performed dropped: ${(error as Error).message}`);
    }
  }
}

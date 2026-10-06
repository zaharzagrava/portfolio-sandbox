import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { normalizeQuery } from '../domain/top-k-trie';
import { SearchResultClicked } from './events/search-click-events';

/**
 * Relevance is measured, not guessed: result clicks + query logs (SD-12) give
 * CTR, mean reciprocal rank and zero-result rate per query - the numbers you
 * look at before and after changing boosts or synonyms.
 */
@Injectable()
export class SearchQualityService {
  constructor(
    private readonly producer: KafkaProducerService,
    private readonly clickhouse: ClickHouseService,
  ) {}

  recordClick(query: string, productId: string, position: number): void {
    const q = normalizeQuery(query);
    const event = SearchResultClicked.create(q, 0, { query: q, productId, position });
    void this.producer.send({ topic: SearchResultClicked.topic, key: q, value: event }).catch(() => undefined);
  }

  async report(days = 7, limit = 50) {
    return this.clickhouse.query<{ query: string; searches: string; ctr: number; mrr: number; zeroResultRate: number }>(
      `WITH s AS (
         SELECT query, count() AS searches, countIf(results = 0) AS zero
         FROM search_queries FINAL WHERE ts >= now() - INTERVAL {days:UInt32} DAY GROUP BY query
       ), c AS (
         SELECT query, count() AS clicks, sum(1 / (position + 1)) AS rr
         FROM search_clicks FINAL WHERE ts >= now() - INTERVAL {days:UInt32} DAY GROUP BY query
       )
       SELECT s.query AS query, s.searches AS searches,
              round(coalesce(c.clicks, 0) / s.searches, 3) AS ctr,
              round(coalesce(c.rr, 0) / s.searches, 3) AS mrr,
              round(s.zero / s.searches, 3) AS zeroResultRate
       FROM s LEFT JOIN c USING (query)
       ORDER BY s.searches DESC LIMIT {limit:UInt32}`,
      { days, limit },
    );
  }
}

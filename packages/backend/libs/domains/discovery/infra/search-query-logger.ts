import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { ApiConfigService } from '@app/common/config';
import { SearchPerformed } from '../application/events/search-query-events';
import { normaliseQuery } from '../domain/query-text';

const normalizeQuery = (q: string): string => normaliseQuery(q).toLowerCase();

/** Fire-and-forget: search latency never waits for analytics. */
@Injectable()
export class SearchQueryLogger {
  private readonly salt: string;

  constructor(
    private readonly producer: KafkaProducerService,
    config: ApiConfigService,
  ) {
    this.salt = config.get('jwt_secret');
  }

  log(rawQuery: string | undefined, results: number, subject: string): void {
    const query = normalizeQuery(rawQuery ?? '');
    if (query.length < 2) return;
    const userHash = createHash('sha256')
      .update(`${this.salt}:${subject}`)
      .digest('hex')
      .slice(0, 16);
    const event = SearchPerformed.create(query, 0, {
      query,
      results,
      userHash,
    });
    void this.producer
      .send({ topic: SearchPerformed.topic, key: query, value: event })
      .catch(() => undefined);
  }
}

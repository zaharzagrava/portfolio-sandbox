import { Injectable } from '@nestjs/common';
import { CassandraService, CqlParams } from '@app/infrastructure/cassandra/cassandra.service';
import { mapWithConcurrency } from '@app/common/core/promise-pool';

/**
 * Cassandra/Scylla resolve concurrent writes per cell by write timestamp (LWW).
 * Writing with `timestamp = aggregate version` makes "newest version wins"
 * hold no matter in which order events arrive - version guarding without
 * lightweight transactions (Paxos round trips).
 *
 * Constraint: tables written this way must ONLY be written by projectors with
 * version timestamps (a normal write's microsecond-epoch timestamp would always win).
 */
@Injectable()
export class CassandraVersionedSink {
  constructor(private readonly cassandra: CassandraService) {}

  async writeAll(writes: { query: string; params: CqlParams; version: number }[], concurrency = 32): Promise<void> {
    await mapWithConcurrency(writes, concurrency, ({ query, params, version }) =>
      this.cassandra.client.execute(query, params as never, { prepare: true, timestamp: version, isIdempotent: true }),
    );
  }
}

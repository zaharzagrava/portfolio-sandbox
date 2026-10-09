import { Injectable } from '@nestjs/common';
import {
  CassandraService,
  CqlParams,
} from '@app/infrastructure/cassandra/cassandra.service';
import { mapWithConcurrency } from '@app/common/core/promise-pool';
import type { SinkCounts } from '../projector';

export interface VersionedCqlWrite {
  query: string;
  params: CqlParams;
  version: number;
  /**
   * Optional read of the cell's current write timestamp (`SELECT writetime(col) AS wt FROM ... WHERE key = ?`), so
   * the outcome can be told apart: equal is a `duplicate`, higher a `stale` write that Cassandra would ignore anyway.
   * Without it every write is counted `applied` (the guarantee is the same, the counts are coarser).
   */
  probe?: { query: string; params: CqlParams };
}

/**
 * Cassandra/Scylla resolve concurrent writes per cell by write timestamp (LWW).
 * Writing with `timestamp = aggregate version` makes "newest version wins"
 * hold no matter in which order events arrive - version guarding without
 * lightweight transactions (Paxos round trips).
 *
 * Constraints: tables written this way must ONLY be written by projectors with version timestamps (a normal write's
 * microsecond-epoch timestamp would always win). Tie rule (S53 FR-043): two writes with the *same* version and
 * different values are resolved by Cassandra by the greater value, whichever arrives first, so the cell converges;
 * with the same value it is the same cell, an idempotent rewrite.
 */
@Injectable()
export class CassandraVersionedSink {
  constructor(private readonly cassandra: CassandraService) {}

  async writeAll(
    writes: VersionedCqlWrite[],
    concurrency = 32,
  ): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    await mapWithConcurrency(writes, concurrency, async (write) => {
      const stored = write.probe
        ? await this.writetime(write.probe)
        : undefined;
      // Always write: LWW makes a stale or equal write harmless, and skipping it would lose the tie rule.
      await this.cassandra.client.execute(write.query, write.params as never, {
        prepare: true,
        timestamp: write.version,
        isIdempotent: true,
      });
      if (stored === undefined || stored < write.version) counts.applied++;
      else if (stored === write.version) counts.duplicate++;
      else counts.stale++;
    });
    return counts;
  }

  private async writetime(probe: {
    query: string;
    params: CqlParams;
  }): Promise<number | undefined> {
    const result = await this.cassandra.client.execute(
      probe.query,
      probe.params as never,
      {
        prepare: true,
      },
    );
    const wt = result.rows[0]?.get('wt');
    return wt === undefined || wt === null ? undefined : Number(wt.toString());
  }
}

import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { auth, Client, policies, types } from 'cassandra-driver';
import { ApiConfigService } from '@app/common/config';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';

export type CqlParams = unknown[] | Record<string, unknown>;

/**
 * ScyllaDB locally / Amazon Keyspaces in AWS (D24) through the Cassandra
 * driver. Defaults chosen for wide-row, write-heavy workloads:
 *  - token-aware routing (requests go straight to a replica owning the partition),
 *  - LOCAL_QUORUM (Keyspaces requires it for writes; RF=3 → tolerate 1 node down),
 *  - always-prepared statements (parsed once, binary protocol, no CQL injection).
 */
@Injectable()
export class CassandraService implements OnModuleInit {
  private readonly logger = new Logger(CassandraService.name);
  readonly client: Client;

  constructor(
    config: ApiConfigService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    const contactPoints = (
      config.get('cassandra_contact_points') ?? 'localhost:9042'
    )
      .split(',')
      .map((s) => s.trim());
    const localDataCenter = config.get('cassandra_local_dc') ?? 'datacenter1';
    const username = config.get('cassandra_username');

    this.client = new Client({
      contactPoints,
      localDataCenter,
      keyspace: config.get('cassandra_keyspace') ?? 'marketplace',
      policies: {
        loadBalancing: new policies.loadBalancing.TokenAwarePolicy(
          new policies.loadBalancing.DCAwareRoundRobinPolicy(localDataCenter),
        ),
        retry: new policies.retry.IdempotenceAwareRetryPolicy(
          new policies.retry.RetryPolicy(),
        ),
      },
      queryOptions: {
        consistency: types.consistencies.localQuorum,
        prepare: true,
      },
      pooling: { coreConnectionsPerHost: { [types.distance.local]: 2 } },
      ...(username && {
        authProvider: new auth.PlainTextAuthProvider(
          username,
          config.get('cassandra_password') ?? '',
        ),
      }),
    });

    shutdown?.register({
      name: 'cassandra.shutdown',
      order: 90,
      run: () => this.client.shutdown(),
    });
  }

  async onModuleInit() {
    try {
      await this.client.connect();
    } catch (error) {
      // Don't crash the whole app at boot: features backed by Scylla fail individually and /health/ready reports it.
      this.logger.error(
        `Cassandra connect failed: ${(error as Error).message}`,
      );
    }
  }

  execute(
    query: string,
    params?: CqlParams,
    options: {
      idempotent?: boolean;
      fetchSize?: number;
      pageState?: string;
    } = {},
  ) {
    return this.client.execute(query, params as never, {
      prepare: true,
      isIdempotent: options.idempotent ?? true,
      ...options,
    });
  }

  /** Unlogged batch: only for statements hitting the SAME partition (atomic + one round trip). */
  batchSamePartition(queries: { query: string; params: CqlParams }[]) {
    return this.client.batch(queries, {
      prepare: true,
      logged: false,
    });
  }
}

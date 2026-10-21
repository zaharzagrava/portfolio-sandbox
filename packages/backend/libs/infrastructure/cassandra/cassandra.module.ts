import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { CassandraService } from './cassandra.service';
import { ReadinessService } from '@app/infrastructure/health';
import { ModuleRef } from '@nestjs/core';
import {
  TEST_CLEANUP,
  TestCleanupPort,
} from '@app/common/testing/test-cleanup.port';

/** Table names per keyspace, read once per process by the test cleaner. */
const tableNamesByKeyspace = new Map<string, string[]>();

@Global()
@Module({
  imports: [ApiConfigModule],
  providers: [CassandraService],
  exports: [CassandraService],
})
export class CassandraModule implements OnModuleInit {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    let readiness: ReadinessService | undefined;
    try {
      readiness = this.moduleRef.get(ReadinessService, { strict: false });
    } catch {
      readiness = undefined;
    }
    // Non-critical: Scylla-backed features (feeds, discussions) degrade; checkout keeps working.
    // e2e specs: SeedsService.clean() truncates every table of the (test) keyspace except migrations bookkeeping.
    try {
      this.moduleRef
        .get<TestCleanupPort>(TEST_CLEANUP, { strict: false })
        .register('cassandra.truncate', async () => {
          const keyspace = this.cassandra.client.keyspace;
          // The table list of a keyspace does not change while the specs run (migrations ran before), so it is read once per
          // process. If a table went missing the probe fails: the list is read again and the pass is repeated once.
          const loadNames = async (): Promise<string[]> => {
            const tables = await this.cassandra.execute(
              'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?',
              [keyspace],
            );
            return tables.rows
              .map((row) => String(row.table_name))
              .filter((name) => name !== 'schema_migrations');
          };
          // TRUNCATE is a heavy schema-level operation (about 240 ms per table on the test node), and one after another over all 41 tables
          // it took 9.8 s on every beforeEach of every suite whose app includes this module (the two assistant suites: 450 s of a 580 s
          // sample). A row check (`LIMIT 1`) costs about 0.4 ms and a test touches a few tables, so only the tables that hold rows are
          // truncated, in parallel. The result is the same: an empty keyspace.
          const probeAll = async (names: string[]): Promise<string[]> =>
            (
              await Promise.all(
                names.map(async (name) => {
                  const probe = await this.cassandra.execute(
                    `SELECT * FROM ${keyspace}.${name} LIMIT 1`,
                  );
                  return probe.rows.length > 0 ? name : null;
                }),
              )
            ).filter((name): name is string => name !== null);
          let cached = tableNamesByKeyspace.get(keyspace);
          let dirty: string[] = [];
          if (cached) {
            try {
              dirty = await probeAll(cached);
            } catch {
              cached = undefined; // stale list: read it again below
            }
          }
          if (!cached) {
            cached = await loadNames();
            if (cached.length > 0) tableNamesByKeyspace.set(keyspace, cached); // never remember an empty (not yet migrated) keyspace
            dirty = await probeAll(cached);
          }
          await Promise.all(
            dirty.map((name) =>
              this.cassandra.execute(`TRUNCATE ${keyspace}.${name}`),
            ),
          );
        });
    } catch {
      // not a test module
    }

    readiness?.register({
      name: 'cassandra',
      critical: false,
      check: async () => {
        await this.cassandra.execute('SELECT now() FROM system.local');
      },
    });
  }
}

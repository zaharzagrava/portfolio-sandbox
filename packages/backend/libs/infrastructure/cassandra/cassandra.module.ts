import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { CassandraService } from './cassandra.service';
import { ReadinessService } from '@app/infrastructure/health';
import { ModuleRef } from '@nestjs/core';
import {
  TEST_CLEANUP,
  TestCleanupPort,
} from '@app/common/testing/test-cleanup.port';

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
          const tables = await this.cassandra.execute(
            'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?',
            [keyspace],
          );
          // TRUNCATE is a heavy schema-level operation (about 240 ms per table on the test node), and one after another over all 41 tables
          // it took 9.8 s on every beforeEach of every suite whose app includes this module (the two assistant suites: 450 s of a 580 s
          // sample). A row check (`LIMIT 1`) costs about 0.4 ms and a test touches a few tables, so only the tables that hold rows are
          // truncated, in parallel. The result is the same: an empty keyspace.
          const names = tables.rows
            .map((row) => String(row.table_name))
            .filter((name) => name !== 'schema_migrations');
          const dirty = (
            await Promise.all(
              names.map(async (name) => {
                const probe = await this.cassandra.execute(
                  `SELECT * FROM ${keyspace}.${name} LIMIT 1`,
                );
                return probe.rows.length > 0 ? name : null;
              }),
            )
          ).filter((name): name is string => name !== null);
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

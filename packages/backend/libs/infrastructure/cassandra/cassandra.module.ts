import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { CassandraService } from './cassandra.service';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { ModuleRef } from '@nestjs/core';
import { TEST_CLEANUP, TestCleanupPort } from '@app/common/testing/test-cleanup.port';

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
      this.moduleRef.get<TestCleanupPort>(TEST_CLEANUP, { strict: false }).register('cassandra.truncate', async () => {
        const keyspace = this.cassandra.client.keyspace;
        const tables = await this.cassandra.execute('SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?', [keyspace]);
        for (const { table_name } of tables.rows) {
          if (table_name !== 'schema_migrations') await this.cassandra.execute(`TRUNCATE ${keyspace}.${table_name}`);
        }
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

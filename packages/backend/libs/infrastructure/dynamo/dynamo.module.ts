import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  ListTablesCommand,
  ScanCommand,
  BatchWriteItemCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import { ApiConfigModule } from '@app/common/config';
import { DynamoService } from './dynamo.service';
import {
  TEST_CLEANUP,
  TestCleanupPort,
} from '@app/common/testing/test-cleanup.port';

@Global()
@Module({
  imports: [ApiConfigModule],
  providers: [DynamoService],
  exports: [DynamoService],
})
export class DynamoModule implements OnModuleInit {
  /** Test-only: key attribute names per table name, for the wipe between tests. */
  private static readonly keyNamesCache = new Map<string, string[]>();

  constructor(
    private readonly dynamo: DynamoService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    let registry: TestCleanupPort;
    try {
      registry = this.moduleRef.get<TestCleanupPort>(TEST_CLEANUP, {
        strict: false,
      });
    } catch {
      return; // not a test module
    }
    if (!registry) return;
    // e2e specs: empty every table of this environment's prefix (test data volumes are tiny).
    // The key names of a table never change while the process runs, so DescribeTable is asked once per table per process, and the
    // tables are emptied at the same time (about 10 tables: one round of requests instead of ten after another).
    const keyNamesOf = DynamoModule.keyNamesCache;
    registry.register('dynamo.truncate', async () => {
      const prefix = this.dynamo.table('');
      const { TableNames = [] } = await this.dynamo.doc.send(
        new ListTablesCommand({}),
      );
      await Promise.all(
        TableNames.filter((t) => t.startsWith(prefix)).map(async (table) => {
          let keyNames = keyNamesOf.get(table);
          if (!keyNames) {
            const { Table } = await this.dynamo.doc.send(
              new DescribeTableCommand({ TableName: table }),
            );
            keyNames = (Table?.KeySchema ?? []).map((k) => k.AttributeName!);
            keyNamesOf.set(table, keyNames);
          }
          let start: Record<string, never> | undefined;
          do {
            const page = await this.dynamo.doc.send(
              new ScanCommand({
                TableName: table,
                ProjectionExpression: keyNames.join(','),
                ExclusiveStartKey: start,
              }),
            );
            const items = page.Items ?? [];
            for (let i = 0; i < items.length; i += 25) {
              await this.dynamo.doc.send(
                new BatchWriteItemCommand({
                  RequestItems: {
                    [table]: items
                      .slice(i, i + 25)
                      .map((Key) => ({ DeleteRequest: { Key } })),
                  },
                }),
              );
            }
            start = page.LastEvaluatedKey as typeof start;
          } while (start);
        }),
      );
    });
  }
}

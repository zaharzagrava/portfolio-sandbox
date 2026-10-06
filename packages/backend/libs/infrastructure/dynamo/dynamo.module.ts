import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ListTablesCommand, ScanCommand, BatchWriteItemCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { DynamoService } from './dynamo.service';
import { TEST_CLEANUP, TestCleanupPort } from '@app/common/testing/test-cleanup.port';

@Global()
@Module({
  imports: [ApiConfigModule],
  providers: [DynamoService],
  exports: [DynamoService],
})
export class DynamoModule implements OnModuleInit {
  constructor(
    private readonly dynamo: DynamoService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    let registry: TestCleanupPort;
    try {
      registry = this.moduleRef.get<TestCleanupPort>(TEST_CLEANUP, { strict: false });
    } catch {
      return; // not a test module
    }
    if (!registry) return;
    // e2e specs: empty every table of this environment's prefix (test data volumes are tiny).
    registry.register('dynamo.truncate', async () => {
      const prefix = this.dynamo.table('');
      const { TableNames = [] } = await this.dynamo.doc.send(new ListTablesCommand({}));
      for (const table of TableNames.filter((t) => t.startsWith(prefix))) {
        const { Table } = await this.dynamo.doc.send(new DescribeTableCommand({ TableName: table }));
        const keyNames = (Table?.KeySchema ?? []).map((k) => k.AttributeName!);
        let start: Record<string, never> | undefined;
        do {
          const page = await this.dynamo.doc.send(
            new ScanCommand({ TableName: table, ProjectionExpression: keyNames.join(','), ExclusiveStartKey: start }),
          );
          const items = page.Items ?? [];
          for (let i = 0; i < items.length; i += 25) {
            await this.dynamo.doc.send(
              new BatchWriteItemCommand({ RequestItems: { [table]: items.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) } }),
            );
          }
          start = page.LastEvaluatedKey as typeof start;
        } while (start);
      }
    });
  }
}

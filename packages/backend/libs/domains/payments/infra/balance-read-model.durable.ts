import { Injectable } from '@nestjs/common';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import type {
  BalanceReadModelStore,
  ReadModelLine,
} from '../domain/ledger-ports';

const TABLE = 'LedgerBalanceView';

/**
 * The durable copy of the balances (research R-8): DynamoDB `LedgerBalanceView`, `accountId` + `shardNo`, written
 * with a conditional put (`attribute_not_exists(version) OR version < :v`) so replays, duplicates and reordering are
 * harmless. No expiry: it survives a loss of the hot store and is rebuilt from the topic or from `AccountBalance`.
 */
@Injectable()
export class DynamoBalanceView implements BalanceReadModelStore {
  constructor(private readonly dynamo: DynamoService) {}

  async putIfNewer(
    line: ReadModelLine,
  ): Promise<'applied' | 'stale' | 'duplicate'> {
    try {
      await this.dynamo.doc.send(
        new PutCommand({
          TableName: this.dynamo.table(TABLE),
          Item: {
            accountId: line.accountId,
            shardNo: line.shard,
            currency: line.currency,
            balanceMinor: line.balanceMinor,
            version: line.version,
            projectedAt: line.projectedAt.toISOString(),
          },
          ConditionExpression:
            'attribute_not_exists(version) OR version < :version',
          ExpressionAttributeValues: { ':version': line.version },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return 'applied';
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      const stored = (error as { Item?: { version?: { N?: string } } }).Item
        ?.version?.N;
      return stored !== undefined && Number(stored) === line.version
        ? 'duplicate'
        : 'stale';
    }
  }

  async overwrite(line: ReadModelLine): Promise<void> {
    await this.dynamo.doc.send(
      new PutCommand({
        TableName: this.dynamo.table(TABLE),
        Item: {
          accountId: line.accountId,
          shardNo: line.shard,
          currency: line.currency,
          balanceMinor: line.balanceMinor,
          version: line.version,
          projectedAt: line.projectedAt.toISOString(),
        },
      }),
    );
  }

  async get(accountId: string): Promise<ReadModelLine[]> {
    const lines: ReadModelLine[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.dynamo.doc.send(
        new QueryCommand({
          TableName: this.dynamo.table(TABLE),
          KeyConditionExpression: 'accountId = :a',
          ExpressionAttributeValues: { ':a': accountId },
          ExclusiveStartKey: start,
        }),
      );
      for (const item of page.Items ?? [])
        lines.push({
          accountId,
          shard: Number(item.shardNo),
          currency: String(item.currency),
          balanceMinor: Number(item.balanceMinor),
          version: Number(item.version),
          projectedAt: new Date(String(item.projectedAt)),
        });
      start = page.LastEvaluatedKey;
    } while (start);
    return lines;
  }
}

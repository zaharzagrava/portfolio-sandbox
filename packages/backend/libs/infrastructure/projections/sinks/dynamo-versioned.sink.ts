import { Injectable } from '@nestjs/common';
import { BatchWriteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { mapWithConcurrency } from '@app/common/core/promise-pool';

/**
 * Version-guarded put: `attribute_not_exists(version) OR version <= :v`. A
 * stale event fails the condition and is skipped - no read-before-write.
 */
@Injectable()
export class DynamoVersionedSink {
  constructor(private readonly dynamo: DynamoService) {}

  async putIfNewer(table: string, item: Record<string, unknown> & { version: number }): Promise<boolean> {
    try {
      await this.dynamo.doc.send(
        new PutCommand({
          TableName: this.dynamo.table(table),
          Item: item,
          ConditionExpression: 'attribute_not_exists(#v) OR #v <= :v',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':v': item.version },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  /** Conditional writes can't be batched in Dynamo; bounded parallelism instead. */
  async putManyIfNewer(table: string, items: (Record<string, unknown> & { version: number })[], concurrency = 16) {
    return mapWithConcurrency(items, concurrency, (item) => this.putIfNewer(table, item));
  }

  /** Unconditional append-only items (time series): BatchWrite, 25 per request. */
  async appendMany(table: string, items: Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < items.length; i += 25) {
      let request = { [this.dynamo.table(table)]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) };
      // Retry unprocessed items (throttling) until none are left.
      for (let attempt = 0; Object.keys(request).length && attempt < 5; attempt++) {
        const res = await this.dynamo.doc.send(new BatchWriteCommand({ RequestItems: request }));
        request = (res.UnprocessedItems ?? {}) as typeof request;
      }
    }
  }
}

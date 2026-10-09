import { Injectable } from '@nestjs/common';
import { BatchWriteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { mapWithConcurrency } from '@app/common/core/promise-pool';
import type { SinkCounts } from '../projector';
import type { VersionDecision } from './apply-if-newer';

export type PutOutcome = 'applied' | Exclude<VersionDecision, 'apply'>;

/** The stored version of an item that failed the condition: marshalled (`{N: '3'}`) or already plain. */
const storedVersion = (item: unknown): number | undefined => {
  const raw = (item as { version?: unknown } | undefined)?.version;
  if (raw === undefined) return undefined;
  const value =
    typeof raw === 'object' && raw !== null && 'N' in raw
      ? (raw as { N: string }).N
      : raw;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Version-guarded put: `attribute_not_exists(version) OR version < :v` (strict, S53 FR-043). A stale or equal event
 * fails the condition and is a skipped outcome, not an error; the failed condition returns the stored item, which
 * tells `duplicate` (equal) from `stale` (older write) without a read-before-write.
 */
@Injectable()
export class DynamoVersionedSink {
  constructor(private readonly dynamo: DynamoService) {}

  async putIfNewer(
    table: string,
    item: Record<string, unknown> & { version: number },
  ): Promise<PutOutcome> {
    try {
      await this.dynamo.doc.send(
        new PutCommand({
          TableName: this.dynamo.table(table),
          Item: item,
          ConditionExpression: 'attribute_not_exists(#v) OR #v < :v',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':v': item.version },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return 'applied';
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        const stored = storedVersion((error as { Item?: unknown }).Item);
        return stored === item.version ? 'duplicate' : 'stale';
      }
      throw error;
    }
  }

  /** Conditional writes can't be batched in Dynamo; bounded parallelism instead. */
  async putManyIfNewer(
    table: string,
    items: (Record<string, unknown> & { version: number })[],
    concurrency = 16,
  ): Promise<SinkCounts> {
    const outcomes = await mapWithConcurrency(items, concurrency, (item) =>
      this.putIfNewer(table, item),
    );
    return {
      applied: outcomes.filter((o) => o === 'applied').length,
      duplicate: outcomes.filter((o) => o === 'duplicate').length,
      stale: outcomes.filter((o) => o === 'stale').length,
    };
  }

  /** Unconditional append-only items (time series): BatchWrite, 25 per request. */
  async appendMany(
    table: string,
    items: Record<string, unknown>[],
  ): Promise<void> {
    for (let i = 0; i < items.length; i += 25) {
      let request = {
        [this.dynamo.table(table)]: items
          .slice(i, i + 25)
          .map((Item) => ({ PutRequest: { Item } })),
      };
      // Retry unprocessed items (throttling) until none are left.
      for (
        let attempt = 0;
        Object.keys(request).length && attempt < 5;
        attempt++
      ) {
        const res = await this.dynamo.doc.send(
          new BatchWriteCommand({ RequestItems: request }),
        );
        request = (res.UnprocessedItems ?? {}) as typeof request;
      }
    }
  }
}

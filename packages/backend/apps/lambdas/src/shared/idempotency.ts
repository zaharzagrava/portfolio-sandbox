import { DeleteCommand, DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export class AlreadyInProgressError extends Error {
  constructor(key: string) {
    super(`${key} is being processed by another invocation`);
    this.name = 'AlreadyInProgressError';
  }
}

/**
 * Exactly-once EFFECTS on top of at-least-once delivery (10/04 #3, Powertools
 * pattern): claim → run → complete. A duplicate delivery of a COMPLETED key
 * returns the stored result without running; a duplicate while another
 * container is mid-flight throws (the message retries later); a crashed
 * attempt's claim expires after `inProgressTtlMs`; a failure releases the claim.
 */
export class Idempotency {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly fn: string,
    private readonly ttlSec = 24 * 3600,
  ) {}

  async run<T>(key: string, inProgressTtlMs: number, work: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    const pk = `${this.fn}#${key}`;
    const now = Date.now();
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { PK: pk, status: 'IN_PROGRESS', inProgressUntil: now + inProgressTtlMs, expiresAtEpoch: Math.floor(now / 1000) + this.ttlSec },
          ConditionExpression: 'attribute_not_exists(PK) OR (#s = :inProgress AND inProgressUntil < :now)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':inProgress': 'IN_PROGRESS', ':now': now },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
    } catch (error) {
      const e = error as { name?: string; Item?: Record<string, { S?: string }> };
      if (e.name !== 'ConditionalCheckFailedException') throw error;
      const status = e.Item?.status?.S;
      if (status === 'COMPLETED') return { result: JSON.parse(e.Item?.result?.S ?? 'null') as T, replayed: true };
      throw new AlreadyInProgressError(pk);
    }

    try {
      const result = await work();
      await this.doc.send(
        new UpdateCommand({ TableName: this.table, Key: { PK: pk }, UpdateExpression: 'SET #s = :done, #r = :result', ExpressionAttributeNames: { '#s': 'status', '#r': 'result' }, ExpressionAttributeValues: { ':done': 'COMPLETED', ':result': JSON.stringify(result ?? null) } }),
      );
      return { result, replayed: false };
    } catch (error) {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { PK: pk } })).catch(() => undefined);
      throw error;
    }
  }
}

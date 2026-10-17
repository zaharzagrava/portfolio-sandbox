import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransientError } from '../errors';
import { log, metric, TOOLKIT_NAMESPACE } from '../telemetry/telemetry';
import {
  AlreadyInProgressError,
  IdempotencyKeyConflictError,
  StaleClaimError,
} from './idempotency-errors';
import { assertValidKey } from './idempotency-key';
import {
  assertValidOptions,
  DEFAULT_RETENTION_SEC,
  type RunOptions,
} from './idempotency-options';

export { AlreadyInProgressError } from './idempotency-errors';

export const MAX_RESULT_BYTES = 64 * 1024;

export interface IdempotencyOptions {
  /** Epoch milliseconds; tests freeze it. */
  now?: () => number;
  /** The function's timeout: a lease below it is rejected (a second container could start while the first runs). */
  functionTimeoutMs?: number;
}

export interface RunResult<T> {
  result: T | undefined;
  replayed: boolean;
  resultOmitted?: boolean;
}

interface StoredRecord {
  status?: string;
  ownerToken?: string;
  fingerprint?: string;
  result?: string;
  resultOmitted?: boolean;
}

const isConditionFailure = (error: unknown) =>
  (error as { name?: string })?.name === 'ConditionalCheckFailedException';

/**
 * Exactly-once EFFECTS on top of at-least-once delivery (10/04 #3, Powertools pattern): claim → run → complete.
 * A duplicate of a COMPLETED key returns the stored result without running; a duplicate while another container is
 * mid-flight throws (the message retries later); a crashed attempt's claim expires with its lease. Each attempt owns
 * the record through a random token: completion and release are conditional on it, so a late finisher never
 * overwrites or deletes a newer attempt's record. A failed COMPLETION write keeps the claim (the work is done and must
 * not be released for another run inside the lease).
 */
export class Idempotency {
  private readonly now: () => number;
  private readonly functionTimeoutMs: number;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly fn: string,
    options: IdempotencyOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.functionTimeoutMs = options.functionTimeoutMs ?? 0;
  }

  async run<T>(
    key: string,
    work: () => Promise<T>,
    options: RunOptions,
  ): Promise<RunResult<T>> {
    assertValidKey(key);
    assertValidOptions(options, this.functionTimeoutMs);
    const pk = `${this.fn}#${key}`;
    const ownerToken = randomUUID();
    const now = this.now();
    const retentionSec = options.retentionSec ?? DEFAULT_RETENTION_SEC;

    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            PK: pk,
            status: 'IN_PROGRESS',
            ownerToken,
            leaseUntil: now + options.leaseMs,
            ...(options.fingerprint !== undefined && {
              fingerprint: options.fingerprint,
            }),
            expiresAtEpoch: Math.floor(now / 1000) + retentionSec,
          },
          ConditionExpression:
            'attribute_not_exists(PK) OR expiresAtEpoch < :nowSec OR (#s = :inProgress AND leaseUntil < :now)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':inProgress': 'IN_PROGRESS',
            ':now': now,
            ':nowSec': Math.floor(now / 1000),
          },
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error))
        throw new TransientError(
          `idempotency store unavailable: ${(error as Error)?.name}`,
          {
            cause: error,
          },
        );
      return this.liveRecord<T>(pk, options);
    }

    let result: T;
    try {
      result = await work();
    } catch (error) {
      await this.release(pk, ownerToken, error);
      throw error;
    }

    const serialised = JSON.stringify(result ?? null);
    const omitted = Buffer.byteLength(serialised) > MAX_RESULT_BYTES;
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: pk },
          UpdateExpression: omitted
            ? 'SET #s = :done, resultOmitted = :true, completedAt = :now'
            : 'SET #s = :done, #r = :result, completedAt = :now',
          ConditionExpression: 'ownerToken = :token',
          ExpressionAttributeNames: omitted
            ? { '#s': 'status' }
            : { '#s': 'status', '#r': 'result' },
          ExpressionAttributeValues: {
            ':done': 'COMPLETED',
            ':token': ownerToken,
            ':now': this.now(),
            ...(omitted ? { ':true': true } : { ':result': serialised }),
          },
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw new StaleClaimError(pk);
      // the work succeeded: keep the claim (a release would let a duplicate redo it inside the lease)
      metric(TOOLKIT_NAMESPACE, 'IdempotencyCompletionFailed', 1, 'Count', {
        function: this.fn,
      });
      log('error', 'idempotency completion write failed; claim kept', {
        function: this.fn,
      });
      throw error;
    }
    return omitted
      ? { result, replayed: false, resultOmitted: true }
      : { result, replayed: false };
  }

  /** The claim failed on a condition: a live record exists. Replay it, or say why this delivery cannot run. */
  private async liveRecord<T>(
    pk: string,
    options: RunOptions,
  ): Promise<RunResult<T>> {
    let record: StoredRecord | undefined;
    try {
      record = (
        await this.doc.send(
          new GetCommand({
            TableName: this.table,
            Key: { PK: pk },
            ConsistentRead: true,
          }),
        )
      ).Item as StoredRecord | undefined;
    } catch (error) {
      throw new TransientError(
        `idempotency store unavailable: ${(error as Error)?.name}`,
        {
          cause: error,
        },
      );
    }
    if (!record) throw new AlreadyInProgressError(pk); // released between the two calls: retry later
    if (
      options.fingerprint !== undefined &&
      record.fingerprint !== undefined &&
      record.fingerprint !== options.fingerprint
    )
      throw new IdempotencyKeyConflictError(pk);
    if (record.status === 'COMPLETED') {
      metric(TOOLKIT_NAMESPACE, 'IdempotencyReplay', 1, 'Count', {
        function: this.fn,
      });
      if (record.resultOmitted)
        return { result: undefined, replayed: true, resultOmitted: true };
      return {
        result: JSON.parse(record.result ?? 'null') as T,
        replayed: true,
      };
    }
    // IN_PROGRESS with a live lease, or a record without a status: a live conflict, never a success
    throw new AlreadyInProgressError(pk);
  }

  private async release(pk: string, ownerToken: string, cause: unknown) {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { PK: pk },
          ConditionExpression: 'ownerToken = :token',
          ExpressionAttributeValues: { ':token': ownerToken },
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw new StaleClaimError(pk, { cause });
      log('warn', 'idempotency release failed; the lease will expire', {
        function: this.fn,
        error: (error as Error)?.name,
      });
    }
  }
}

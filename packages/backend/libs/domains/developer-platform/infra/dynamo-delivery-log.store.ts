import { Injectable } from '@nestjs/common';
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import {
  AttemptRecord,
  CancelReason,
  ClaimOutcome,
  DeliveryLog,
  DeliveryRecord,
  DeliveryTransition,
  deliveryKey,
} from '../domain/webhook-ports';

type Item = Record<string, any>;

const TABLE = 'WebhookAttempts';
const deliveryPk = (endpointId: string) => `endpoint#${endpointId}`;
const deliverySk = (eventId: string) => `delivery#${eventId}`;
const attemptSk = (startedAt: Date, attemptId: string) =>
  `attempt#${startedAt.toISOString()}#${attemptId}`;
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const date = (s: string | null | undefined): Date | null =>
  s ? new Date(s) : null;

const isConditionFailure = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException ||
  (error as { name?: string })?.name === 'ConditionalCheckFailedException';

const toDelivery = (item: Item): DeliveryRecord => ({
  endpointId: String(item.PK).slice('endpoint#'.length),
  shopId: item.shopId,
  eventId: item.eventId,
  deliveryId: item.deliveryId,
  type: item.type,
  kind: item.kind,
  state: item.state,
  attempt: Number(item.attempt),
  nextAttemptAt: date(item.nextAttemptAt),
  claimedAt: date(item.claimedAt),
  ...(item.cancelReason && { cancelReason: item.cancelReason }),
  ...(item.failureReason && { failureReason: item.failureReason }),
  body: item.body,
  createdAt: new Date(item.createdAt),
  expiresAt: new Date(Number(item.expiresAtEpoch) * 1000),
});

const toAttempt = (item: Item): AttemptRecord => ({
  endpointId: String(item.PK).slice('endpoint#'.length),
  deliveryId: item.deliveryId,
  eventId: item.eventId,
  type: item.type,
  attemptId: item.attemptId,
  attempt: Number(item.attempt),
  startedAt: new Date(item.startedAt),
  durationMs: Number(item.durationMs),
  status: item.status ?? null,
  ok: Boolean(item.ok),
  ...(item.error && { error: item.error }),
  ...(item.responseSnippet && { responseSnippet: item.responseSnippet }),
  replay: Boolean(item.replay),
  expiresAt: new Date(Number(item.expiresAtEpoch) * 1000),
});

/**
 * Delivery state and attempt log in DynamoDB `WebhookAttempts` (S43 data-model.md; TTL attribute `expiresAtEpoch`,
 * 30 days). Delivery item `PK=endpoint#<id> SK=delivery#<eventId>`, attempt item
 * `PK=endpoint#<id> SK=attempt#<startedAt>#<attemptId>`. Reads filter `expiresAtEpoch > now` themselves: the TTL
 * sweep is lazy, so an item past its time must never be returned (AS-60, AS-67). Never stored: signature, request
 * headers, secrets, the URL path or query.
 */
@Injectable()
export class DynamoDeliveryLogStore extends DeliveryLog {
  constructor(private readonly dynamo: DynamoService) {
    super();
  }

  private get table() {
    return this.dynamo.table(TABLE);
  }

  async createDelivery(
    delivery: DeliveryRecord,
  ): Promise<'created' | 'exists'> {
    try {
      await this.dynamo.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            PK: deliveryPk(delivery.endpointId),
            SK: deliverySk(deliveryKey(delivery)),
            shopId: delivery.shopId,
            eventId: delivery.eventId,
            deliveryId: delivery.deliveryId,
            type: delivery.type,
            kind: delivery.kind,
            state: delivery.state,
            attempt: delivery.attempt,
            nextAttemptAt: iso(delivery.nextAttemptAt),
            claimedAt: iso(delivery.claimedAt),
            body: delivery.body,
            createdAt: delivery.createdAt.toISOString(),
            expiresAtEpoch: epoch(delivery.expiresAt),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return 'created';
    } catch (error) {
      if (isConditionFailure(error)) return 'exists';
      throw error;
    }
  }

  async getDelivery(
    endpointId: string,
    eventId: string,
    now: Date,
  ): Promise<DeliveryRecord | null> {
    const res = await this.dynamo.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: deliveryPk(endpointId), SK: deliverySk(eventId) },
        ConsistentRead: true,
      }),
    );
    if (!res.Item || Number(res.Item.expiresAtEpoch) <= epoch(now)) return null;
    return toDelivery(res.Item);
  }

  async claim(
    endpointId: string,
    eventId: string,
    attempt: number,
    now: Date,
    staleAfterMs: number,
  ): Promise<ClaimOutcome> {
    const key = { PK: deliveryPk(endpointId), SK: deliverySk(eventId) };
    const nowEpoch = epoch(now);
    const common = {
      TableName: this.table,
      Key: key,
      ReturnValues: 'ALL_NEW' as const,
      ExpressionAttributeNames: { '#state': 'state', '#attempt': 'attempt' },
    };
    try {
      // Normal claim: the pending attempt carried by the message.
      const res = await this.dynamo.doc.send(
        new UpdateCommand({
          ...common,
          UpdateExpression:
            'SET #state = :delivering, claimedAt = :now, claimedAtMs = :nowMs',
          ConditionExpression:
            'attribute_exists(PK) AND #state IN (:queued, :retry) AND #attempt = :n AND expiresAtEpoch > :nowEpoch',
          ExpressionAttributeValues: {
            ':delivering': 'delivering',
            ':queued': 'queued',
            ':retry': 'retry_scheduled',
            ':n': attempt,
            ':now': now.toISOString(),
            ':nowMs': now.getTime(),
            ':nowEpoch': nowEpoch,
          },
        }),
      );
      return { claimed: true, delivery: toDelivery(res.Attributes as Item) };
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
    try {
      // In doubt: a claim older than the visibility margin means the worker died; the repeat consumes the next number.
      const res = await this.dynamo.doc.send(
        new UpdateCommand({
          ...common,
          UpdateExpression:
            'SET #attempt = #attempt + :one, claimedAt = :now, claimedAtMs = :nowMs',
          ConditionExpression:
            'attribute_exists(PK) AND #state = :delivering AND #attempt = :n AND claimedAtMs < :staleBefore AND expiresAtEpoch > :nowEpoch',
          ExpressionAttributeValues: {
            ':delivering': 'delivering',
            ':n': attempt,
            ':one': 1,
            ':now': now.toISOString(),
            ':nowMs': now.getTime(),
            ':staleBefore': now.getTime() - staleAfterMs,
            ':nowEpoch': nowEpoch,
          },
        }),
      );
      return { claimed: true, delivery: toDelivery(res.Attributes as Item) };
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
    const current = await this.getDelivery(endpointId, eventId, now);
    if (!current) return { claimed: false, reason: 'missing' };
    switch (current.state) {
      case 'delivered':
        return { claimed: false, reason: 'delivered' };
      case 'exhausted':
      case 'cancelled':
      case 'failed':
        return { claimed: false, reason: 'terminal' };
      case 'delivering':
        return { claimed: false, reason: 'in_flight' };
      default:
        return { claimed: false, reason: 'stale' };
    }
  }

  async recordAttempt(
    attempt: AttemptRecord,
    next: DeliveryTransition,
  ): Promise<void> {
    const names: Record<string, string> = {
      '#state': 'state',
      '#attempt': 'attempt',
    };
    const values: Record<string, unknown> = {
      ':delivering': 'delivering',
      ':n': attempt.attempt,
      ':nextState': next.state,
      ':nextAttempt': next.attempt,
    };
    let update =
      'SET #state = :nextState, #attempt = :nextAttempt REMOVE claimedAt, claimedAtMs';
    const set: string[] = [];
    if (next.nextAttemptAt) {
      set.push('nextAttemptAt = :nextAt');
      values[':nextAt'] = next.nextAttemptAt.toISOString();
    } else {
      update += ', nextAttemptAt';
    }
    if (next.cancelReason) {
      set.push('cancelReason = :cancelReason');
      values[':cancelReason'] = next.cancelReason;
    }
    if (next.failureReason) {
      set.push('failureReason = :failureReason');
      values[':failureReason'] = next.failureReason;
    }
    if (set.length > 0)
      update = update.replace('SET ', `SET ${set.join(', ')}, `);
    try {
      await this.dynamo.transactWrite([
        {
          Put: {
            TableName: this.table,
            Item: {
              PK: deliveryPk(attempt.endpointId),
              SK: attemptSk(attempt.startedAt, attempt.attemptId),
              attemptId: attempt.attemptId,
              deliveryId: attempt.deliveryId,
              eventId: attempt.eventId,
              type: attempt.type,
              attempt: attempt.attempt,
              startedAt: attempt.startedAt.toISOString(),
              durationMs: attempt.durationMs,
              status: attempt.status,
              ok: attempt.ok,
              ...(attempt.error && { error: attempt.error }),
              ...(attempt.responseSnippet && {
                responseSnippet: attempt.responseSnippet,
              }),
              replay: attempt.replay,
              expiresAtEpoch: epoch(attempt.expiresAt),
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Update: {
            TableName: this.table,
            Key: {
              PK: deliveryPk(attempt.endpointId),
              SK: deliverySk(
                deliveryKey({
                  kind: attempt.replay ? 'replay' : 'event',
                  eventId: attempt.eventId,
                  deliveryId: attempt.deliveryId,
                }),
              ),
            },
            UpdateExpression: update,
            // Only the worker that holds this attempt number records it: a superseded worker records nothing.
            ConditionExpression: '#state = :delivering AND #attempt = :n',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          },
        },
      ]);
    } catch (error) {
      // Superseded by a later claim of the same delivery (this attempt was in doubt): nothing to record twice.
      if (error instanceof TransactionCanceledException) {
        const codes = (error.CancellationReasons ?? []).map((r) => r.Code);
        if (codes.includes('ConditionalCheckFailed')) return;
      }
      throw error;
    }
  }

  async release(
    endpointId: string,
    eventId: string,
    attempt: number,
    nextAttemptAt: Date,
  ): Promise<void> {
    try {
      await this.dynamo.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: deliveryPk(endpointId), SK: deliverySk(eventId) },
          UpdateExpression:
            'SET #state = :retry, nextAttemptAt = :next REMOVE claimedAt, claimedAtMs',
          ConditionExpression:
            'attribute_exists(PK) AND #state = :delivering AND #attempt = :n',
          ExpressionAttributeNames: {
            '#state': 'state',
            '#attempt': 'attempt',
          },
          ExpressionAttributeValues: {
            ':retry': 'retry_scheduled',
            ':delivering': 'delivering',
            ':n': attempt,
            ':next': nextAttemptAt.toISOString(),
          },
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error; // superseded by a later claim: nothing to give back
    }
  }

  async cancel(
    endpointId: string,
    eventId: string,
    reason: CancelReason,
  ): Promise<void> {
    try {
      await this.dynamo.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: deliveryPk(endpointId), SK: deliverySk(eventId) },
          UpdateExpression:
            'SET #state = :cancelled, cancelReason = :reason REMOVE claimedAt, claimedAtMs, nextAttemptAt',
          ConditionExpression:
            'attribute_exists(PK) AND #state IN (:queued, :retry, :delivering)',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':cancelled': 'cancelled',
            ':reason': reason,
            ':queued': 'queued',
            ':retry': 'retry_scheduled',
            ':delivering': 'delivering',
          },
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error; // already terminal or gone: nothing to cancel
    }
  }

  async cancelPending(
    endpointId: string,
    reason: CancelReason,
  ): Promise<number> {
    let cancelled = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.dynamo.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          FilterExpression: '#state IN (:queued, :retry, :delivering)',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':pk': deliveryPk(endpointId),
            ':prefix': 'delivery#',
            ':queued': 'queued',
            ':retry': 'retry_scheduled',
            ':delivering': 'delivering',
          },
          ProjectionExpression: 'PK, SK',
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) {
        try {
          await this.dynamo.doc.send(
            new UpdateCommand({
              TableName: this.table,
              Key: { PK: item.PK, SK: item.SK },
              UpdateExpression:
                'SET #state = :cancelled, cancelReason = :reason REMOVE claimedAt, claimedAtMs, nextAttemptAt',
              ConditionExpression:
                'attribute_exists(PK) AND #state IN (:queued, :retry, :delivering)',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: {
                ':cancelled': 'cancelled',
                ':reason': reason,
                ':queued': 'queued',
                ':retry': 'retry_scheduled',
                ':delivering': 'delivering',
              },
            }),
          );
          cancelled++;
        } catch (error) {
          if (!isConditionFailure(error)) throw error; // finished or cancelled meanwhile
        }
      }
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return cancelled;
  }

  async listAttempts(
    endpointId: string,
    query: {
      eventId?: string;
      ok?: boolean;
      limit: number;
      after?: { startedAt: Date; attemptId: string };
    },
    now: Date,
  ): Promise<AttemptRecord[]> {
    const out: AttemptRecord[] = [];
    const filters = ['expiresAtEpoch > :nowEpoch'];
    const values: Record<string, unknown> = {
      ':pk': deliveryPk(endpointId),
      ':nowEpoch': epoch(now),
    };
    if (query.eventId) {
      filters.push('eventId = :eventId');
      values[':eventId'] = query.eventId;
    }
    if (query.ok !== undefined) {
      filters.push('ok = :ok');
      values[':ok'] = query.ok;
    }
    values[':prefix'] = 'attempt#';
    // Newest first; the cursor resumes strictly after `(startedAt, attemptId)` in that direction, so an attempt inserted
    // between two page calls (a later sort key) never shifts the next page (AS-60).
    let startKey: Record<string, unknown> | undefined = query.after
      ? {
          PK: deliveryPk(endpointId),
          SK: attemptSk(query.after.startedAt, query.after.attemptId),
        }
      : undefined;
    do {
      const res = await this.dynamo.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          FilterExpression: filters.join(' AND '),
          ExpressionAttributeValues: values,
          ScanIndexForward: false,
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of res.Items ?? []) {
        out.push(toAttempt(item));
        if (out.length >= query.limit) return out;
      }
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return out;
  }

  async countAttempts(
    endpointId: string,
    eventId: string,
    now: Date,
  ): Promise<number> {
    let count = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.dynamo.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          FilterExpression: 'eventId = :eventId AND expiresAtEpoch > :nowEpoch',
          ExpressionAttributeValues: {
            ':pk': deliveryPk(endpointId),
            ':prefix': 'attempt#',
            ':eventId': eventId,
            ':nowEpoch': epoch(now),
          },
          Select: 'COUNT',
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      count += res.Count ?? 0;
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return count;
  }

  async deleteForEndpoint(endpointId: string, limit: number): Promise<number> {
    const res = await this.dynamo.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': deliveryPk(endpointId) },
        ProjectionExpression: 'PK, SK',
        Limit: limit,
        ConsistentRead: true,
      }),
    );
    const keys = (res.Items ?? []).map((i) => ({ PK: i.PK, SK: i.SK }));
    for (let i = 0; i < keys.length; i += 25) {
      await this.dynamo.doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.table]: keys
              .slice(i, i + 25)
              .map((Key) => ({ DeleteRequest: { Key } })),
          },
        }),
      );
    }
    return keys.length;
  }
}

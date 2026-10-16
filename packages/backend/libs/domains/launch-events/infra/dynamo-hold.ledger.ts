import { Injectable, Logger } from '@nestjs/common';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { HOLD_RECORD_RETENTION_SEC } from '../domain/constants';
import type { HoldState } from '../domain/hold-state';
import {
  SeatHeldError,
  type HoldLedger,
  type HoldRecord,
  type SeatRecord,
} from '../domain/ports';
import { launchMetrics } from '../launch-metrics';

const TABLE = 'Holds';
const FOREVER = Number.MAX_SAFE_INTEGER;
const NAMES = { '#st': 'state' };

const holdKey = (holdId: string) => ({ PK: `HOLD#${holdId}`, SK: 'META' });
const seatKey = (eventId: string, seat: number) => ({
  PK: `EVENT#${eventId}`,
  SK: `SEAT#${String(seat).padStart(6, '0')}`,
});
const retentionEpoch = (expiresAtMs: number) =>
  Math.ceil(expiresAtMs / 1000) + HOLD_RECORD_RETENTION_SEC;

const isConditionFailure = (error: unknown) =>
  error instanceof ConditionalCheckFailedException ||
  (error as { name?: string })?.name === 'ConditionalCheckFailedException';

/**
 * The durable hold ledger (P0311, P0326). One seat record per (event, seat) with a fencing number that grows with every
 * new hold and is never deleted; every write is conditional on the hold ID and the fence it was given. A hold item per
 * hold keeps its state machine. Records stay after release (FR-019); only the retention TTL removes them.
 */
@Injectable()
export class DynamoHoldLedger implements HoldLedger {
  private readonly logger = new Logger(DynamoHoldLedger.name);

  constructor(private readonly dynamo: DynamoService) {}

  async create(input: {
    holdId: string;
    eventId: string;
    userId: string;
    seats: number[];
    createdAtMs: number;
    expiresAtMs: number;
  }): Promise<HoldRecord> {
    const { holdId, eventId, userId, createdAtMs, expiresAtMs } = input;
    const seats = [...input.seats].sort((a, b) => a - b);
    const fences: Record<string, number> = {};
    const taken: number[] = [];
    try {
      for (const seat of seats) {
        try {
          const { Attributes } = await this.dynamo.doc.send(
            new UpdateCommand({
              TableName: this.dynamo.table(TABLE),
              Key: seatKey(eventId, seat),
              UpdateExpression:
                'SET holdId = :h, userId = :u, expiresAtMs = :exp, #st = :held, expiresAtEpoch = :ttl, seat = :seat, fence = if_not_exists(fence, :zero) + :one',
              ConditionExpression:
                'attribute_not_exists(PK) OR expiresAtMs <= :now',
              ExpressionAttributeNames: NAMES,
              ExpressionAttributeValues: {
                ':h': holdId,
                ':u': userId,
                ':exp': expiresAtMs,
                ':held': 'HELD',
                ':ttl': retentionEpoch(expiresAtMs),
                ':seat': seat,
                ':zero': 0,
                ':one': 1,
                ':now': createdAtMs,
              },
              ReturnValues: 'ALL_NEW',
            }),
          );
          fences[String(seat)] = Number(Attributes?.fence);
          taken.push(seat);
        } catch (error) {
          if (isConditionFailure(error)) throw new SeatHeldError(seat);
          throw error;
        }
      }
      const hold: HoldRecord = {
        holdId,
        eventId,
        userId,
        seats,
        fences,
        state: 'HELD',
        expiresAtMs,
        createdAtMs,
      };
      await this.dynamo.doc.send(
        new PutCommand({
          TableName: this.dynamo.table(TABLE),
          Item: {
            ...holdKey(holdId),
            ...hold,
            expiresAtEpoch: retentionEpoch(expiresAtMs),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return hold;
    } catch (error) {
      // Remove only what this hold wrote (hold ID + fence); a record a newer hold took over is left alone (AS-17, AS-27).
      await this.freeSeats({
        holdId,
        eventId,
        userId,
        seats: taken,
        fences,
        state: 'HELD',
        expiresAtMs,
        createdAtMs,
      });
      throw error;
    }
  }

  async get(holdId: string): Promise<HoldRecord | null> {
    const { Item } = await this.dynamo.doc.send(
      new GetCommand({
        TableName: this.dynamo.table(TABLE),
        Key: holdKey(holdId),
        ConsistentRead: true,
      }),
    );
    if (!Item) return null;
    return {
      holdId: Item.holdId,
      eventId: Item.eventId,
      userId: Item.userId,
      seats: Item.seats,
      fences: Item.fences ?? {},
      state: Item.state as HoldState,
      expiresAtMs: Number(Item.expiresAtMs),
      createdAtMs: Number(Item.createdAtMs),
      confirmedAtMs:
        Item.confirmedAtMs === undefined
          ? undefined
          : Number(Item.confirmedAtMs),
    };
  }

  async transition(
    holdId: string,
    from: HoldState,
    to: HoldState,
    options: { nowMs?: number; lapsed?: boolean } = {},
  ): Promise<boolean> {
    const values: Record<string, unknown> = { ':from': from, ':to': to };
    let condition = '#st = :from';
    if (options.lapsed !== undefined && options.nowMs !== undefined) {
      values[':now'] = options.nowMs;
      condition += options.lapsed
        ? ' AND expiresAtMs <= :now'
        : ' AND expiresAtMs > :now';
    }
    let update = 'SET #st = :to';
    if (to === 'CONFIRMED' && options.nowMs !== undefined) {
      update += ', confirmedAtMs = :at';
      values[':at'] = options.nowMs;
    }
    try {
      await this.dynamo.doc.send(
        new UpdateCommand({
          TableName: this.dynamo.table(TABLE),
          Key: holdKey(holdId),
          UpdateExpression: update,
          ConditionExpression: condition,
          ExpressionAttributeNames: NAMES,
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async revokeConfirmation(holdId: string): Promise<boolean> {
    try {
      await this.dynamo.doc.send(
        new UpdateCommand({
          TableName: this.dynamo.table(TABLE),
          Key: holdKey(holdId),
          UpdateExpression: 'SET #st = :released',
          ConditionExpression: '#st IN (:confirming, :confirmed)',
          ExpressionAttributeNames: NAMES,
          ExpressionAttributeValues: {
            ':released': 'RELEASED',
            ':confirming': 'CONFIRMING',
            ':confirmed': 'CONFIRMED',
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async freeSeats(
    hold: HoldRecord,
  ): Promise<{ freed: number[]; failed: number[] }> {
    const freed: number[] = [];
    const failed: number[] = [];
    for (const seat of hold.seats) {
      try {
        await this.dynamo.doc.send(
          new UpdateCommand({
            TableName: this.dynamo.table(TABLE),
            Key: seatKey(hold.eventId, seat),
            UpdateExpression: 'SET expiresAtMs = :zero, #st = :free',
            ConditionExpression: 'holdId = :h AND fence = :f',
            ExpressionAttributeNames: NAMES,
            ExpressionAttributeValues: {
              ':zero': 0,
              ':free': 'FREE',
              ':h': hold.holdId,
              ':f': hold.fences[String(seat)],
            },
          }),
        );
        freed.push(seat);
      } catch (error) {
        if (isConditionFailure(error)) continue; // freed already, or owned by a newer hold: not ours to touch
        failed.push(seat);
        launchMetrics.rollbackFailed.add(1);
        this.logger.warn(
          `seat record of a hold could not be freed: ${(error as Error)?.name}`,
        );
      }
    }
    return { freed, failed };
  }

  async confirmSeats(hold: HoldRecord): Promise<void> {
    for (const seat of hold.seats) {
      try {
        await this.dynamo.doc.send(
          new UpdateCommand({
            TableName: this.dynamo.table(TABLE),
            Key: seatKey(hold.eventId, seat),
            UpdateExpression:
              'SET #st = :confirmed, expiresAtMs = :forever REMOVE expiresAtEpoch',
            ConditionExpression: 'holdId = :h AND fence = :f',
            ExpressionAttributeNames: NAMES,
            ExpressionAttributeValues: {
              ':confirmed': 'CONFIRMED',
              ':forever': FOREVER,
              ':h': hold.holdId,
              ':f': hold.fences[String(seat)],
            },
          }),
        );
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
        this.logger.warn('seat record of a confirmed hold was taken over');
      }
    }
  }

  async records(eventId: string): Promise<SeatRecord[]> {
    const out: SeatRecord[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.dynamo.doc.send(
        new QueryCommand({
          TableName: this.dynamo.table(TABLE),
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: {
            ':pk': `EVENT#${eventId}`,
            ':sk': 'SEAT#',
          },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      for (const item of page.Items ?? []) {
        out.push({
          seat: Number(item.seat),
          holdId: item.holdId,
          userId: item.userId,
          fence: Number(item.fence),
          state:
            item.state === 'CONFIRMED'
              ? 'CONFIRMED'
              : item.state === 'FREE'
                ? 'FREE'
                : 'HELD',
          expiresAtMs: Number(item.expiresAtMs),
        });
      }
      start = page.LastEvaluatedKey;
    } while (start);
    return out;
  }
}

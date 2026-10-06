import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { v7 as uuidv7 } from 'uuid';
import { UniqueConstraintError } from 'sequelize';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import Booking from '../infra/models/booking.model';
import LaunchEvent from '../infra/models/launch-event.model';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'launch-events.expire-hold': { holdId: string };
  }
}

export const HOLD_MS = 10 * 60_000;
const TABLE = 'Holds';
const CONFIRMED_EXPIRY = Number.MAX_SAFE_INTEGER;

/** Delete the Redis seat lock only if WE still own it (another hold may own it after expiry). */
const COMPARE_AND_DELETE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

const seatLock = (eventId: string, seat: number) => `seat:{${eventId}}:${seat}`;
export const seatMapKey = (eventId: string) => `seatmap:{${eventId}}`;

/**
 * Seat holds - exactly one winner per seat (lesson 10/07 #21):
 *  1. Redis `SET seat NX PX` - cheap first filter, rejects 99% of losers in ~0.2 ms;
 *  2. DynamoDB conditional put (`attribute_not_exists OR expired`) - the durable,
 *     authoritative hold, still without any Postgres row lock;
 *  3. CONFIRM writes Postgres, guarded by a partial unique index (one CONFIRMED per seat).
 * Multi-seat holds are all-or-nothing: on any failure the seats already taken are rolled back.
 * The seat map is a Redis bitmap (1 bit/seat) updated on hold/confirm/release and pushed as
 * deltas over SSE; it's a display hint - correctness lives in steps 1-3.
 */
@Injectable()
export class SeatHoldService {
  constructor(
    private readonly redis: RedisService,
    private readonly dynamo: DynamoService,
    private readonly realtime: RealtimePublisher,
    private readonly jobs: JobsService,
    @InjectModel(Booking) private readonly bookingModel: typeof Booking,
  ) {}

  async hold(event: LaunchEvent, userId: string, seats: number[]): Promise<{ holdId: string; seats: number[]; expiresAt: Date }> {
    const unique = [...new Set(seats)].sort((a, b) => a - b);
    if (unique.some((s) => s < 0 || s >= event.seatCount)) throw new UnprocessableEntityException('Unknown seat');
    await this.claimUserQuota(event, userId, unique.length);

    const holdId = uuidv7();
    const expiresAtMs = Date.now() + HOLD_MS;
    const taken: number[] = [];
    try {
      for (const seat of unique) {
        const locked = await this.redis.client.set(seatLock(event.id, seat), holdId, 'PX', HOLD_MS, 'NX');
        if (locked !== 'OK') throw new ConflictException({ message: `Seat ${seat} is taken`, code: 'SEAT_TAKEN', seat });
        taken.push(seat);
        await this.putSeatHold(event.id, seat, holdId, userId, expiresAtMs);
      }
    } catch (error) {
      await this.rollback(event.id, holdId, taken);
      await this.redis.client.decrby(`launch:${event.id}:user:${userId}`, unique.length);
      throw error;
    }

    await this.dynamo.doc.send(
      new PutCommand({
        TableName: this.dynamo.table(TABLE),
        Item: { PK: `HOLD#${holdId}`, SK: 'META', eventId: event.id, userId, seats: unique, expiresAtMs, expiresAtEpoch: Math.ceil(expiresAtMs / 1000) + 3600 },
      }),
    );
    await this.markSeats(event.id, unique, 1, 'held');
    await this.jobs.enqueue('launch-events.expire-hold', { holdId }, { runAt: new Date(expiresAtMs), idempotencyKey: `hold-expire:${holdId}` });
    return { holdId, seats: unique, expiresAt: new Date(expiresAtMs) };
  }

  async confirm(holdId: string, userId: string): Promise<Booking[]> {
    const hold = await this.getHold(holdId);
    if (!hold || hold.userId !== userId) throw new NotFoundException('Hold not found');
    if (hold.confirmed) return this.bookingModel.findAll({ where: { holdId } });
    if (hold.expiresAtMs < Date.now()) throw new ConflictException({ message: 'Hold expired', code: 'HOLD_EXPIRED' });

    let bookings: Booking[];
    try {
      bookings = await this.bookingModel.bulkCreate(
        hold.seats.map((seat: number) => ({ eventId: hold.eventId, seat, userId, holdId })),
        { ignoreDuplicates: false },
      );
    } catch (error) {
      // Idempotent retry of the same hold → return what exists; another hold's booking on the seat → conflict.
      if (error instanceof UniqueConstraintError) {
        const existing = await this.bookingModel.findAll({ where: { holdId } });
        if (existing.length === hold.seats.length) return existing;
        throw new ConflictException({ message: 'Seat already booked', code: 'SEAT_TAKEN' });
      }
      throw error;
    }

    // Seats stay taken forever now; the hold record is marked confirmed so the expiry job leaves it alone.
    for (const seat of hold.seats as number[]) {
      await this.dynamo.doc.send(
        new UpdateCommand({
          TableName: this.dynamo.table(TABLE),
          Key: { PK: `EVENT#${hold.eventId}`, SK: `SEAT#${seat}` },
          UpdateExpression: 'SET expiresAtMs = :forever REMOVE expiresAtEpoch',
          ConditionExpression: 'holdId = :holdId',
          ExpressionAttributeValues: { ':forever': CONFIRMED_EXPIRY, ':holdId': holdId },
        }),
      );
      await this.redis.client.persist(seatLock(hold.eventId, seat));
    }
    await this.dynamo.doc.send(
      new UpdateCommand({ TableName: this.dynamo.table(TABLE), Key: { PK: `HOLD#${holdId}`, SK: 'META' }, UpdateExpression: 'SET confirmed = :t', ExpressionAttributeValues: { ':t': true } }),
    );
    await this.markSeats(hold.eventId, hold.seats, 1, 'booked');
    return bookings;
  }

  /** User cancel or expiry. No-op for confirmed holds. */
  async release(holdId: string, userId?: string): Promise<boolean> {
    const hold = await this.getHold(holdId);
    if (!hold || hold.confirmed) return false;
    if (userId && hold.userId !== userId) throw new ForbiddenException();

    await this.rollback(hold.eventId, holdId, hold.seats);
    await this.dynamo.doc.send(new DeleteCommand({ TableName: this.dynamo.table(TABLE), Key: { PK: `HOLD#${holdId}`, SK: 'META' } }));
    await this.redis.client.decrby(`launch:${hold.eventId}:user:${hold.userId}`, hold.seats.length);
    await this.markSeats(hold.eventId, hold.seats, 0, 'released');
    return true;
  }

  async seatMap(eventId: string): Promise<string> {
    const bitmap = await this.redis.client.getBuffer(seatMapKey(eventId));
    return (bitmap ?? Buffer.alloc(0)).toString('base64');
  }

  private async putSeatHold(eventId: string, seat: number, holdId: string, userId: string, expiresAtMs: number) {
    try {
      await this.dynamo.doc.send(
        new PutCommand({
          TableName: this.dynamo.table(TABLE),
          Item: { PK: `EVENT#${eventId}`, SK: `SEAT#${seat}`, holdId, userId, expiresAtMs, expiresAtEpoch: Math.ceil(expiresAtMs / 1000) + 3600 },
          // Free, or the previous hold expired (TTL deletion is lazy - can lag hours - so check the time ourselves).
          ConditionExpression: 'attribute_not_exists(PK) OR expiresAtMs < :now',
          ExpressionAttributeValues: { ':now': Date.now() },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) throw new ConflictException({ message: `Seat ${seat} is taken`, code: 'SEAT_TAKEN', seat });
      throw error;
    }
  }

  private async rollback(eventId: string, holdId: string, seats: number[]) {
    for (const seat of seats) {
      await this.redis.client.eval(COMPARE_AND_DELETE, 1, seatLock(eventId, seat), holdId).catch(() => undefined);
      await this.dynamo.doc
        .send(
          new DeleteCommand({
            TableName: this.dynamo.table(TABLE),
            Key: { PK: `EVENT#${eventId}`, SK: `SEAT#${seat}` },
            ConditionExpression: 'holdId = :holdId',
            ExpressionAttributeValues: { ':holdId': holdId },
          }),
        )
        .catch(() => undefined);
    }
  }

  private async claimUserQuota(event: LaunchEvent, userId: string, count: number) {
    const key = `launch:${event.id}:user:${userId}`;
    const total = await this.redis.client.incrby(key, count);
    await this.redis.client.expire(key, 30 * 86_400);
    if (total > event.perUserLimit) {
      await this.redis.client.decrby(key, count);
      throw new UnprocessableEntityException(`Limit of ${event.perUserLimit} seats per person`);
    }
  }

  private async getHold(holdId: string) {
    const { Item } = await this.dynamo.doc.send(new GetCommand({ TableName: this.dynamo.table(TABLE), Key: { PK: `HOLD#${holdId}`, SK: 'META' } }));
    return Item as { eventId: string; userId: string; seats: number[]; expiresAtMs: number; confirmed?: boolean } | undefined;
  }

  private async markSeats(eventId: string, seats: number[], bit: 0 | 1, change: 'held' | 'booked' | 'released') {
    const pipeline = this.redis.client.pipeline();
    for (const seat of seats) pipeline.setbit(seatMapKey(eventId), seat, bit);
    await pipeline.exec();
    await this.realtime.publish(`event:${eventId}:seatmap`, 'seats', { change, seats }).catch(() => undefined);
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfirmResponseDto } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { CONFIRM_WAIT_MS } from '../domain/constants';
import {
  LaunchEventError,
  eventClosed,
  holdExpired,
  holdNotFound,
  holdReleased,
  holdsUnavailable,
  seatTaken,
  ticketLimitExceeded,
} from '../domain/errors';
import {
  BOOKING_REPOSITORY,
  EVENT_REPOSITORY,
  HOLD_LEDGER,
  SEAT_LOCK_STORE,
  SeatConflictError,
  type BookingRecord,
  type BookingRepository,
  type EventRepository,
  type HoldLedger,
  type HoldRecord,
  type SeatLockStore,
} from '../domain/ports';
import { launchMetrics } from '../launch-metrics';
import { EventGateService } from './event-gate.service';
import { HoldLifecycleService } from './hold-lifecycle.service';
import { LaunchEventOutbox } from './launch-event-outbox';
import { LaunchEventService } from './launch-event.service';
import { SeatMapService } from './seat-map.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Confirmed {
  response: ConfirmResponseDto;
  /** `true` for the confirm that made the bookings, `false` for a repeat of an already confirmed hold. */
  created: boolean;
}

const toResponse = (
  hold: HoldRecord,
  rows: BookingRecord[],
): ConfirmResponseDto => ({
  holdId: hold.holdId,
  eventId: hold.eventId,
  bookings: rows.map((row) => ({ bookingId: row.id, seat: row.seat })),
  confirmedAt: rows[0].confirmedAt.toISOString(),
});

/**
 * Hold → booking, exactly once (P0304, P0311). The protocol (research D-5):
 *  1. seal the ledger `HELD → CONFIRMING` (conditional on state and a live hold; expiry needs `HELD`, so the two exclude
 *     each other);
 *  2. ONE transaction: lock the event row, re-check the buyer's limit against the bookings, insert the bookings (the
 *     partial unique index is the final guard), history, the `booking_confirmed` event, the voucher command and, for the
 *     last seat, `ON_SALE → SOLD_OUT` — no call to Redis, Dynamo or a queue inside;
 *  3. finalise the ledger `CONFIRMED`, keep the lock, mark the seat map.
 * A failure in step 2 returns the hold to `HELD`; a crash after it is repaired by the reconciler.
 */
@Injectable()
export class ConfirmService {
  private readonly logger = new Logger(ConfirmService.name);

  constructor(
    @Inject(HOLD_LEDGER) private readonly ledger: HoldLedger,
    @Inject(BOOKING_REPOSITORY) private readonly bookings: BookingRepository,
    @Inject(EVENT_REPOSITORY) private readonly events: EventRepository,
    @Inject(SEAT_LOCK_STORE) private readonly locks: SeatLockStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tx: TransactionRunner,
    private readonly gates: EventGateService,
    private readonly lifecycle: HoldLifecycleService,
    private readonly outbox: LaunchEventOutbox,
    private readonly eventService: LaunchEventService,
    private readonly seatMap: SeatMapService,
  ) {}

  async confirm(holdId: string, userId: string): Promise<Confirmed> {
    const hold = await this.load(holdId, userId);
    const decided = await this.decide(hold);
    if (decided) return decided;

    const nowMs = this.clock.nowMs();
    const gate = await this.gates.require(hold.eventId).catch(() => null);
    if (gate?.status === 'CLOSED') {
      launchMetrics.confirms.add(1, { outcome: 'conflict' });
      throw eventClosed();
    }
    if (nowMs >= hold.expiresAtMs) {
      await this.lifecycle.expireHold(hold, { requireLapsed: true });
      launchMetrics.confirms.add(1, { outcome: 'expired' });
      throw holdExpired();
    }

    const sealed = await this.call(() =>
      this.ledger.transition(holdId, 'HELD', 'CONFIRMING', {
        nowMs,
        lapsed: false,
      }),
    );
    if (!sealed) return this.afterLostSeal(holdId, userId);

    let result: { rows: BookingRecord[]; soldOut: boolean };
    try {
      result = await this.book(hold, nowMs);
    } catch (error) {
      await this.unseal(holdId);
      if (error instanceof SeatConflictError)
        return this.afterConflict(hold, error);
      if (error instanceof LaunchEventError) {
        launchMetrics.confirms.add(1, { outcome: 'conflict' });
        throw error;
      }
      launchMetrics.confirms.add(1, { outcome: 'failed' });
      throw error; // a generic 5xx: the key is released and the buyer retries
    }

    await this.finalise(hold, result.rows, nowMs);
    if (result.soldOut) await this.eventService.afterChange(hold.eventId);
    launchMetrics.confirms.add(1, { outcome: 'confirmed' });
    return { response: toResponse(hold, result.rows), created: true };
  }

  // ------------------------------------------------------------------------------------------------- the steps

  private async load(holdId: string, userId: string): Promise<HoldRecord> {
    const hold = await this.call(() => this.ledger.get(holdId));
    if (!hold || hold.userId !== userId) throw holdNotFound();
    return hold;
  }

  /** The answer for a hold that is not `HELD`; `null` when it is and the confirm goes on. */
  private async decide(hold: HoldRecord): Promise<Confirmed | null> {
    switch (hold.state) {
      case 'HELD':
        return null;
      case 'RELEASED':
        throw holdReleased();
      case 'EXPIRED':
        launchMetrics.confirms.add(1, { outcome: 'expired' });
        throw holdExpired();
      case 'CONFIRMED':
      case 'CONFIRMING':
        return this.existing(hold);
    }
  }

  /** Another confirm made (or is making) the bookings: wait for them and answer the same ones. */
  private async existing(hold: HoldRecord): Promise<Confirmed> {
    for (let waited = 0; ; waited += 25) {
      const rows = await this.bookings.forHold(hold.holdId);
      if (rows.length > 0) {
        launchMetrics.confirms.add(1, { outcome: 'replay' });
        return { response: toResponse(hold, rows), created: false };
      }
      if (waited >= CONFIRM_WAIT_MS) break;
      await sleep(25);
    }
    // Still sealed, nothing booked: the sealing confirm died. Put the hold back so the buyer's retry can go through.
    await this.unseal(hold.holdId);
    throw holdsUnavailable();
  }

  private async afterLostSeal(
    holdId: string,
    userId: string,
  ): Promise<Confirmed> {
    const hold = await this.load(holdId, userId);
    const decided = await this.decide(hold);
    if (decided) return decided;
    // Still `HELD` although the seal failed: it lapsed in between.
    launchMetrics.confirms.add(1, { outcome: 'expired' });
    throw holdExpired();
  }

  private book(
    hold: HoldRecord,
    at: number,
  ): Promise<{ rows: BookingRecord[]; soldOut: boolean }> {
    return this.tx.run(async () => {
      const event = await this.events.lockById(hold.eventId);
      if (!event) throw holdNotFound();
      if (event.status === 'CLOSED') throw eventClosed();
      const booked = await this.bookings.seatsOfUser(event.id, hold.userId);
      if (booked.length + hold.seats.length > event.perUserLimit)
        throw ticketLimitExceeded(
          event.perUserLimit,
          Math.max(0, event.perUserLimit - booked.length),
        );
      const confirmedAt = new Date(at);
      const rows = await this.bookings.insertConfirmed({
        eventId: event.id,
        holdId: hold.holdId,
        userId: hold.userId,
        seats: hold.seats,
        at: confirmedAt,
      });
      await this.outbox.bookingConfirmed({
        holdId: hold.holdId,
        event,
        userId: hold.userId,
        seats: hold.seats,
        bookingIds: rows.map((row) => row.id),
        confirmedAt,
      });
      await this.outbox.voucherRequested({
        holdId: hold.holdId,
        bookingIds: rows.map((row) => row.id),
        launchEventId: event.id,
        shopId: event.shopId,
        userId: hold.userId,
        seatCount: hold.seats.length,
      });
      let soldOut = false;
      if (
        event.status === 'ON_SALE' &&
        (await this.bookings.count(event.id)) >= event.seatCount
      ) {
        soldOut = await this.events.transition(
          event.id,
          'ON_SALE',
          'SOLD_OUT',
          {
            reason: 'last_seat_booked',
          },
        );
        if (soldOut) await this.outbox.soldOut(event);
      }
      return { rows, soldOut };
    });
  }

  /** Step 3: the ledger and the map follow the committed bookings. A failure here is repaired by the reconciler. */
  private async finalise(
    hold: HoldRecord,
    rows: BookingRecord[],
    nowMs: number,
  ): Promise<void> {
    try {
      await this.ledger.transition(hold.holdId, 'CONFIRMING', 'CONFIRMED', {
        nowMs,
      });
      await this.ledger.confirmSeats(hold);
      await Promise.all(
        hold.seats.map((seat) =>
          this.locks
            .keepBooked(hold.eventId, seat, hold.holdId)
            .catch(() => undefined),
        ),
      );
    } catch (error) {
      this.logger.warn(`ledger not finalised: ${(error as Error)?.name}`);
    }
    await this.seatMap.mark(hold.eventId, hold.seats, 'booked');
    void rows;
  }

  private async unseal(holdId: string): Promise<void> {
    try {
      await this.ledger.transition(holdId, 'CONFIRMING', 'HELD');
    } catch (error) {
      this.logger.warn(`hold not unsealed: ${(error as Error)?.name}`);
    }
  }

  /** The unique index refused a seat: nothing was written. If it was this hold's own bookings, that is a replay. */
  private async afterConflict(
    hold: HoldRecord,
    conflict: SeatConflictError,
  ): Promise<Confirmed> {
    const own = await this.bookings.forHold(hold.holdId);
    if (own.length > 0) {
      launchMetrics.confirms.add(1, { outcome: 'replay' });
      return { response: toResponse(hold, own), created: false };
    }
    const seat =
      conflict.seat ??
      (await this.bookings.confirmedSeats(hold.eventId)).find((row) =>
        hold.seats.includes(row.seat),
      )?.seat;
    launchMetrics.confirms.add(1, { outcome: 'seat_taken' });
    throw seatTaken(seat);
  }

  /** A ledger fault is `503`, not a generic `500`: the buyer may retry at once. */
  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof LaunchEventError) throw error;
      this.logger.warn(`ledger call failed: ${(error as Error)?.name}`);
      throw holdsUnavailable();
    }
  }
}

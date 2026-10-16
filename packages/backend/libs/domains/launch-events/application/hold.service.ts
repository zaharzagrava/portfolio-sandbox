import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { HoldDto, HoldSeatsRequest } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import {
  DERIVED_KEY_TTL_SEC,
  EXPIRE_HOLD_JOB,
  HOLD_MS,
  holdExpireJobKey,
} from '../domain/constants';
import {
  LaunchEventError,
  holdsUnavailable,
  noSeatsAvailable,
  seatTaken,
  seatsNotSelectable,
  ticketLimitExceeded,
  unknownSeat,
} from '../domain/errors';
import { holdGateConflict } from '../domain/event-state';
import {
  BOOKING_REPOSITORY,
  HOLD_LEDGER,
  LAUNCH_RANDOM,
  QUOTA_STORE,
  SEAT_LOCK_STORE,
  SeatHeldError,
  type BookingRepository,
  type GateRecord,
  type HoldLedger,
  type HoldRecord,
  type QuotaStore,
  type SeatLockStore,
} from '../domain/ports';
import { hasSeat } from '../domain/seat-bitmap';
import { pickSeats } from '../domain/seat-picker';
import { launchMetrics } from '../launch-metrics';
import './launch-event.job-types';
import { EventGateService } from './event-gate.service';
import { LaunchLimits } from './launch-limits';
import { SeatMapService } from './seat-map.service';

const MAX_PICK_ATTEMPTS = 30;

type Outcome = 'created' | 'seat_taken' | 'limit' | 'unavailable' | 'no_seats';

/**
 * Seat holds: exactly one winner per seat (P0311, P0326). The order of checks is fixed (G-13): the admission token was
 * verified before this runs; then the limiter, the authoritative event status, the seat list, the quota, and last the
 * seats themselves (first-filter lock, then the conditional write in the ledger). Any failure after the quota claim gives
 * the claim back once; a rollback removes only what this hold wrote.
 */
@Injectable()
export class HoldService {
  private readonly logger = new Logger(HoldService.name);

  constructor(
    @Inject(HOLD_LEDGER) private readonly ledger: HoldLedger,
    @Inject(SEAT_LOCK_STORE) private readonly locks: SeatLockStore,
    @Inject(QUOTA_STORE) private readonly quota: QuotaStore,
    @Inject(BOOKING_REPOSITORY) private readonly bookings: BookingRepository,
    @Inject(LAUNCH_RANDOM) private readonly random: () => number,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly gates: EventGateService,
    private readonly seatMap: SeatMapService,
    private readonly limits: LaunchLimits,
    private readonly jobs: JobsService,
  ) {}

  async hold(
    eventId: string,
    userId: string,
    request: HoldSeatsRequest,
  ): Promise<HoldDto> {
    if (
      (await this.limits.take('launch.hold.user', `user:${userId}`)) ===
      'unavailable'
    )
      throw this.fail('unavailable', holdsUnavailable());

    const gate = await this.gateFor(eventId);
    const conflict = holdGateConflict(gate.status);
    if (conflict) throw new LaunchEventError(conflict);

    const wanted = this.validated(gate, request);
    const count = 'quantity' in request ? request.quantity : wanted.length;
    const used = await this.claimQuota(gate, userId, count);

    const holdId = uuidv7();
    const createdAtMs = this.clock.nowMs();
    const expiresAtMs = createdAtMs + HOLD_MS;
    const locked: number[] = [];
    let hold: HoldRecord;
    try {
      hold =
        'quantity' in request
          ? await this.holdBest(
              gate,
              userId,
              holdId,
              request.quantity,
              createdAtMs,
              expiresAtMs,
            )
          : await this.holdSeats(
              gate,
              userId,
              holdId,
              wanted,
              createdAtMs,
              expiresAtMs,
              locked,
            );
    } catch (error) {
      await this.undo(gate, userId, holdId, locked, count);
      if (error instanceof SeatHeldError)
        throw this.fail('seat_taken', seatTaken(error.seat));
      if (error instanceof LaunchEventError)
        throw this.fail(
          error.launchCode === 'SEAT_TAKEN'
            ? 'seat_taken'
            : error.launchCode === 'NO_SEATS_AVAILABLE'
              ? 'no_seats'
              : 'unavailable',
          error,
        );
      this.logger.warn(`hold failed: ${(error as Error)?.name}`);
      throw this.fail('unavailable', holdsUnavailable());
    }

    await this.seatMap.mark(eventId, hold.seats, 'held');
    await this.jobs
      .enqueue(
        EXPIRE_HOLD_JOB,
        { holdId },
        {
          runAt: new Date(expiresAtMs),
          idempotencyKey: holdExpireJobKey(holdId),
        },
      )
      .catch((error) =>
        // The lapse is honoured by the ledger either way; the reconciler ends the hold if the job is lost.
        this.logger.warn(`expiry job not queued: ${(error as Error)?.name}`),
      );
    launchMetrics.holds.add(1, { outcome: 'created' });
    return {
      holdId,
      eventId,
      seats: hold.seats,
      expiresAt: new Date(expiresAtMs).toISOString(),
      serverTime: new Date(this.clock.nowMs()).toISOString(),
      limit: {
        perUser: gate.perUserLimit,
        remaining: Math.max(0, gate.perUserLimit - used),
      },
    };
  }

  // ----------------------------------------------------------------------------------------------- the checks

  private async gateFor(eventId: string): Promise<GateRecord> {
    try {
      return await this.gates.require(eventId);
    } catch (error) {
      if (error instanceof LaunchEventError) throw error;
      throw this.fail('unavailable', holdsUnavailable());
    }
  }

  /** Distinct, in range, selectable seats (`quantity` requests return no list). Nothing is changed by these refusals. */
  private validated(gate: GateRecord, request: HoldSeatsRequest): number[] {
    if ('quantity' in request) return [];
    if (gate.seatingMode === 'GENERAL') throw seatsNotSelectable();
    const seats = [...new Set(request.seats)].sort((a, b) => a - b);
    for (const seat of seats)
      if (seat >= gate.seatCount) throw unknownSeat(seat);
    return seats;
  }

  private async claimQuota(
    gate: GateRecord,
    userId: string,
    count: number,
  ): Promise<number> {
    const ttlSec = Math.min(
      DERIVED_KEY_TTL_SEC,
      Math.max(
        3600,
        Math.ceil((gate.startsAtMs - this.clock.nowMs()) / 1000) + 86_400,
      ),
    );
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const claim = await this.quota.claim(
          gate.eventId,
          userId,
          count,
          gate.perUserLimit,
          ttlSec,
        );
        if (claim === 'missing') {
          // The counter is a cache: rebuilt from bookings and active holds, never trusted blindly (AS-24).
          await this.quota.seed(
            gate.eventId,
            userId,
            await this.usedSeats(gate, userId),
            ttlSec,
          );
          continue;
        }
        if (!claim.ok)
          throw this.fail(
            'limit',
            ticketLimitExceeded(
              gate.perUserLimit,
              Math.max(0, gate.perUserLimit - claim.used),
            ),
          );
        return claim.used;
      }
      throw new Error('quota counter did not appear');
    } catch (error) {
      if (error instanceof LaunchEventError) throw error;
      this.logger.warn(`quota failed: ${(error as Error)?.name}`);
      throw this.fail('unavailable', holdsUnavailable());
    }
  }

  /** Seats the buyer holds or has booked: the union of the bookings and the live ledger records. */
  private async usedSeats(gate: GateRecord, userId: string): Promise<number> {
    const nowMs = this.clock.nowMs();
    const seats = new Set(
      await this.bookings.seatsOfUser(gate.eventId, userId),
    );
    for (const record of await this.ledger.records(gate.eventId))
      if (
        record.userId === userId &&
        (record.state === 'CONFIRMED' ||
          (record.state === 'HELD' && record.expiresAtMs > nowMs))
      )
        seats.add(record.seat);
    return seats.size;
  }

  // ------------------------------------------------------------------------------------------------ the seats

  private async holdSeats(
    gate: GateRecord,
    userId: string,
    holdId: string,
    seats: number[],
    createdAtMs: number,
    expiresAtMs: number,
    locked: number[],
  ): Promise<HoldRecord> {
    let lockStoreUp = true;
    for (const seat of seats) {
      if (!lockStoreUp) break;
      try {
        const taken = await this.locks.tryLock(
          gate.eventId,
          seat,
          holdId,
          expiresAtMs,
          createdAtMs,
        );
        if (!taken) throw new SeatHeldError(seat);
        locked.push(seat);
      } catch (error) {
        if (error instanceof SeatHeldError) throw error;
        // The fast lock store is down: correctness comes from the ledger alone (AS-29).
        lockStoreUp = false;
        launchMetrics.holdDegraded.add(1, { store: 'locks' });
      }
    }
    return this.ledger.create({
      holdId,
      eventId: gate.eventId,
      userId,
      seats,
      createdAtMs,
      expiresAtMs,
    });
  }

  /** Best-available: pick from what the map shows free, let the ledger decide, exclude a collided seat and pick again. */
  private async holdBest(
    gate: GateRecord,
    userId: string,
    holdId: string,
    quantity: number,
    createdAtMs: number,
    expiresAtMs: number,
  ): Promise<HoldRecord> {
    const exclude = new Set<number>();
    let free = await this.freeFromMap(gate);
    let authoritative = false;
    for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
      const picked = pickSeats({
        free: free.filter((seat) => !exclude.has(seat)),
        quantity,
        seatsPerRow: gate.seatsPerRow,
        random: this.random,
      });
      if (!picked) {
        if (authoritative) throw noSeatsAvailable();
        free = await this.freeFromTruth(gate);
        authoritative = true;
        exclude.clear();
        continue;
      }
      try {
        return await this.ledger.create({
          holdId,
          eventId: gate.eventId,
          userId,
          seats: picked,
          createdAtMs,
          expiresAtMs,
        });
      } catch (error) {
        if (!(error instanceof SeatHeldError)) throw error;
        exclude.add(error.seat);
        if (attempt % 5 === 4) {
          free = await this.freeFromTruth(gate);
          authoritative = true;
          exclude.clear();
        }
      }
    }
    throw noSeatsAvailable();
  }

  private async freeFromMap(gate: GateRecord): Promise<number[]> {
    try {
      const { bitmap } = await this.seatMap.snapshot(gate);
      const free: number[] = [];
      for (let seat = 0; seat < gate.seatCount; seat++)
        if (!hasSeat(bitmap, seat)) free.push(seat);
      return free;
    } catch {
      return this.freeFromTruth(gate);
    }
  }

  private async freeFromTruth(gate: GateRecord): Promise<number[]> {
    const taken = await this.seatMap.truth(gate);
    const free: number[] = [];
    for (let seat = 0; seat < gate.seatCount; seat++)
      if (!taken.has(seat)) free.push(seat);
    return free;
  }

  // ---------------------------------------------------------------------------------------------- the clean-up

  /** Gives back what a failed hold took: its locks and its quota claim, once. */
  private async undo(
    gate: GateRecord,
    userId: string,
    holdId: string,
    locked: number[],
    count: number,
  ): Promise<void> {
    await Promise.all(
      locked.map((seat) =>
        this.locks
          .release(gate.eventId, seat, holdId)
          .catch(() => launchMetrics.rollbackFailed.add(1)),
      ),
    );
    await this.quota
      .credit(gate.eventId, userId, count)
      .catch(() => launchMetrics.rollbackFailed.add(1));
  }

  private fail(outcome: Outcome, error: LaunchEventError): LaunchEventError {
    launchMetrics.holds.add(1, { outcome });
    return error;
  }
}

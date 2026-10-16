import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { seatMapSchema } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { DistributedLock } from '@app/infrastructure/cache';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { emptyBitmap, setSeat } from '../domain/seat-bitmap';
import {
  BOOKING_REPOSITORY,
  HOLD_LEDGER,
  SEAT_MAP_STORE,
  type BookingRepository,
  type GateRecord,
  type HoldLedger,
  type SeatChange,
  type SeatMapSnapshot,
  type SeatMapStore,
} from '../domain/ports';
import { launchMetrics } from '../launch-metrics';
import { EventGateService } from './event-gate.service';

export type SeatMapDto = z.infer<typeof seatMapSchema>;

const REBUILD_LOCK_MS = 10_000;
const WAIT_STEP_MS = 25;
const WAIT_MAX_MS = 2_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The seat map: a display hint, never the authority (FR-040). Reads come from Redis; a lost map is rebuilt from the
 * authoritative state (confirmed bookings plus active holds) behind a single flight; every change is published as a
 * delta whose `seq` was assigned in the same step as the bit (FR-039).
 */
@Injectable()
export class SeatMapService {
  private readonly logger = new Logger(SeatMapService.name);
  private readonly rebuilding = new Map<string, Promise<SeatMapSnapshot>>();

  constructor(
    @Inject(SEAT_MAP_STORE) private readonly store: SeatMapStore,
    @Inject(HOLD_LEDGER) private readonly ledger: HoldLedger,
    @Inject(BOOKING_REPOSITORY) private readonly bookings: BookingRepository,
    private readonly gates: EventGateService,
    private readonly realtime: RealtimePublisher,
    private readonly locks: DistributedLock,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async read(eventId: string): Promise<SeatMapDto> {
    const gate = await this.gates.require(eventId);
    const snapshot = await this.snapshot(gate);
    return {
      eventId,
      seatCount: gate.seatCount,
      seatsPerRow: gate.seatsPerRow,
      seq: snapshot.seq,
      bitmap: snapshot.bitmap.toString('base64'),
    };
  }

  /** Sets or clears the seats and publishes the delta. Never throws: a failed display update is repaired by the reconciler. */
  async mark(
    eventId: string,
    seats: number[],
    change: SeatChange,
  ): Promise<void> {
    if (seats.length === 0) return;
    try {
      const applied = await this.store.apply(
        eventId,
        seats,
        change !== 'released',
      );
      if (!applied) return; // the map is absent: the next read rebuilds it from the truth, which already has this change
      await this.realtime.publish(`event:${eventId}:seatmap`, 'seats', {
        seq: applied.seq,
        change,
        seats,
      });
    } catch (error) {
      launchMetrics.publishFailed.add(1);
      this.logger.warn(`seat map update failed: ${(error as Error)?.name}`);
    }
  }

  /** What the bitmap must show, from the ledger and the bookings. */
  async truth(gate: GateRecord): Promise<Set<number>> {
    const nowMs = this.clock.nowMs();
    const taken = new Set<number>();
    for (const booking of await this.bookings.confirmedSeats(gate.eventId))
      taken.add(booking.seat);
    for (const record of await this.ledger.records(gate.eventId)) {
      if (record.state === 'CONFIRMED') taken.add(record.seat);
      else if (record.state === 'HELD' && record.expiresAtMs > nowMs)
        taken.add(record.seat);
    }
    return taken;
  }

  async snapshot(gate: GateRecord): Promise<SeatMapSnapshot> {
    const found = await this.store.read(gate.eventId, gate.seatCount);
    if (found) return found;
    return this.rebuild(gate);
  }

  private rebuild(gate: GateRecord): Promise<SeatMapSnapshot> {
    const running = this.rebuilding.get(gate.eventId);
    if (running) return running;
    const flight = this.rebuildOnce(gate).finally(() =>
      this.rebuilding.delete(gate.eventId),
    );
    this.rebuilding.set(gate.eventId, flight);
    return flight;
  }

  private async rebuildOnce(gate: GateRecord): Promise<SeatMapSnapshot> {
    const lock = await this.locks.tryAcquire(`launch-map:${gate.eventId}`, {
      ttlMs: REBUILD_LOCK_MS,
    });
    if (!lock) {
      // Another instance is rebuilding: wait for its result instead of building a second copy.
      for (let waited = 0; waited < WAIT_MAX_MS; waited += WAIT_STEP_MS) {
        await sleep(WAIT_STEP_MS);
        const found = await this.store.read(gate.eventId, gate.seatCount);
        if (found) return found;
      }
    }
    try {
      const existing = await this.store.read(gate.eventId, gate.seatCount);
      if (existing) return existing;
      let bitmap = emptyBitmap(gate.seatCount);
      for (const seat of await this.truth(gate)) bitmap = setSeat(bitmap, seat);
      // `seq` starts at the clock: it never goes backwards after a wipe, so a client's `last + 1` rule stays sound.
      return await this.store.seed(gate.eventId, bitmap, this.clock.nowMs());
    } finally {
      await lock?.release().catch(() => undefined);
    }
  }
}

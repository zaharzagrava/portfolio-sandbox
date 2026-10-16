import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { DistributedLock } from '@app/infrastructure/cache';
import { RECONCILE_GRACE_MS } from '../domain/constants';
import { hasSeat } from '../domain/seat-bitmap';
import {
  BOOKING_REPOSITORY,
  EVENT_REPOSITORY,
  HOLD_LEDGER,
  QUEUE_STORE,
  type BookingRepository,
  type EventRepository,
  type HoldLedger,
  type HoldRecord,
  type LaunchEventRecord,
  type QueueStore,
} from '../domain/ports';
import { launchMetrics } from '../launch-metrics';
import { gateOf } from './event-gate.service';
import { HoldLifecycleService } from './hold-lifecycle.service';
import { SeatMapService } from './seat-map.service';

const LOCK_MS = 55_000;
/** Closed events stay in the sweep this long so their last holds are ended. */
const CLOSED_LOOKBACK_MS = 15 * 60_000;

export interface ReconcileReport {
  events: number;
  repairs: Record<string, number>;
  doubleBooked: number;
}

/**
 * Repairs drift between the three stores (FR-036, AS-41, AS-48): the ledger, the seat map and the bookings. The database
 * is the truth for a booking, the ledger for a hold. Every repair is a conditional, idempotent step, and one worker per
 * event acts at a time (a `DistributedLock`), so two workers repair each drift once. Also runs the double-booking
 * detector, which must always find zero.
 */
@Injectable()
export class ReconcileService {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    @Inject(EVENT_REPOSITORY) private readonly events: EventRepository,
    @Inject(BOOKING_REPOSITORY) private readonly bookings: BookingRepository,
    @Inject(HOLD_LEDGER) private readonly ledger: HoldLedger,
    @Inject(QUEUE_STORE) private readonly queue: QueueStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly lifecycle: HoldLifecycleService,
    private readonly seatMap: SeatMapService,
    private readonly lock: DistributedLock,
  ) {}

  async run(): Promise<ReconcileReport> {
    const report: ReconcileReport = { events: 0, repairs: {}, doubleBooked: 0 };
    const since = new Date(this.clock.nowMs() - CLOSED_LOOKBACK_MS);
    for (const event of await this.events.listReconcilable(since)) {
      const lease = await this.lock.tryAcquire(`launch-reconcile:${event.id}`, {
        ttlMs: LOCK_MS,
      });
      if (!lease) continue;
      try {
        report.events++;
        await this.reconcileEvent(event, report);
      } catch (error) {
        this.logger.warn(`reconcile failed: ${(error as Error)?.name}`);
      } finally {
        await lease.release().catch(() => undefined);
      }
    }
    report.doubleBooked = await this.bookings.countDoubleBooked();
    if (report.doubleBooked > 0)
      launchMetrics.doubleBooking.add(report.doubleBooked);
    return report;
  }

  private repaired(report: ReconcileReport, kind: string, n = 1) {
    if (n <= 0) return;
    report.repairs[kind] = (report.repairs[kind] ?? 0) + n;
    launchMetrics.reconcileRepairs.add(n, { kind });
  }

  async reconcileEvent(
    event: LaunchEventRecord,
    report: ReconcileReport,
  ): Promise<void> {
    const nowMs = this.clock.nowMs();
    if (event.status === 'CLOSED') {
      await this.queue.clear(event.id).catch(() => undefined);
      this.repaired(
        report,
        'closed_event_holds',
        await this.lifecycle.expireForEvent(event.id, { onlyLapsed: false }),
      );
    } else {
      this.repaired(
        report,
        'lapsed_hold',
        await this.lifecycle.expireForEvent(event.id, { onlyLapsed: true }),
      );
    }

    const bookings = await this.bookings.confirmedSeats(event.id);
    const holdIds = new Set(bookings.map((b) => b.holdId));
    // A booking whose hold the ledger still shows sealed or held: finish the confirmation the crash cut short.
    for (const holdId of holdIds) {
      const hold = await this.ledger.get(holdId);
      if (!hold || hold.state === 'CONFIRMED') continue;
      if (hold.state === 'HELD')
        await this.ledger.transition(holdId, 'HELD', 'CONFIRMING');
      if (hold.state === 'HELD' || hold.state === 'CONFIRMING') {
        await this.ledger.transition(holdId, 'CONFIRMING', 'CONFIRMED', {
          nowMs,
        });
        await this.ledger.confirmSeats(hold);
        await this.seatMap.mark(event.id, hold.seats, 'booked');
        this.repaired(report, 'booking_without_ledger');
      }
    }

    // A ledger that says confirmed (or sealed too long) for which no booking exists: the seat is freed.
    const booked = new Set(bookings.map((b) => `${b.holdId}:${b.seat}`));
    const orphanHolds = new Map<string, HoldRecord>();
    for (const record of await this.ledger.records(event.id)) {
      if (record.state === 'FREE' || record.expiresAtMs <= nowMs) continue;
      if (booked.has(`${record.holdId}:${record.seat}`)) continue;
      const hold =
        orphanHolds.get(record.holdId) ??
        (await this.ledger.get(record.holdId));
      if (!hold) continue;
      orphanHolds.set(record.holdId, hold);
    }
    for (const hold of orphanHolds.values()) {
      if (hold.state !== 'CONFIRMED' && hold.state !== 'CONFIRMING') continue;
      if ((await this.bookings.forHold(hold.holdId)).length > 0) continue;
      const since =
        hold.state === 'CONFIRMED'
          ? (hold.confirmedAtMs ?? hold.createdAtMs)
          : hold.createdAtMs;
      if (nowMs - since < RECONCILE_GRACE_MS) continue;
      if (!(await this.ledger.revokeConfirmation(hold.holdId))) continue;
      await this.lifecycle.runEffects(hold);
      this.repaired(report, 'ledger_without_booking');
    }

    await this.repairMap(event, report);
  }

  /** Makes the bitmap show what the ledger and the bookings say (a lost bit is set, a stray bit cleared). */
  private async repairMap(
    event: LaunchEventRecord,
    report: ReconcileReport,
  ): Promise<void> {
    const gate = gateOf(event);
    const snapshot = await this.seatMap.snapshot(gate);
    const truth = await this.seatMap.truth(gate);
    const stray: number[] = [];
    const missing: number[] = [];
    for (let seat = 0; seat < event.seatCount; seat++) {
      const shown = hasSeat(snapshot.bitmap, seat);
      if (shown && !truth.has(seat)) stray.push(seat);
      else if (!shown && truth.has(seat)) missing.push(seat);
    }
    if (stray.length > 0) {
      await this.seatMap.mark(event.id, stray, 'released');
      this.repaired(report, 'map_stray_bit', stray.length);
    }
    if (missing.length > 0) {
      await this.seatMap.mark(event.id, missing, 'held');
      this.repaired(report, 'map_missing_bit', missing.length);
    }
  }
}

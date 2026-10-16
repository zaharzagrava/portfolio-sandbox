import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { holdAlreadyConfirmed, holdNotFound } from '../domain/errors';
import {
  HOLD_LEDGER,
  QUOTA_STORE,
  SEAT_LOCK_STORE,
  type HoldLedger,
  type HoldRecord,
  type QuotaStore,
  type SeatLockStore,
} from '../domain/ports';
import { launchMetrics } from '../launch-metrics';
import { SeatMapService } from './seat-map.service';

/**
 * How a hold ends without becoming a booking (FR-024, FR-025, FR-027): the conditional `HELD → RELEASED|EXPIRED` update
 * comes first and only its winner runs the effects (seat records, locks, quota credit, map bits), so a release racing the
 * expiry job credits the buyer exactly once (AS-23). Effects are best-effort after the winning update; what a failure
 * leaves behind (a ghost lock, a stale bit) is repaired by the reconciler and expires by itself.
 */
@Injectable()
export class HoldLifecycleService {
  private readonly logger = new Logger(HoldLifecycleService.name);

  constructor(
    @Inject(HOLD_LEDGER) private readonly ledger: HoldLedger,
    @Inject(SEAT_LOCK_STORE) private readonly locks: SeatLockStore,
    @Inject(QUOTA_STORE) private readonly quota: QuotaStore,
    private readonly seatMap: SeatMapService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The buyer lets go of a hold. Cross-user access is `404`; a confirmed hold is `409`; an ended one is a no-op. */
  async release(holdId: string, userId: string): Promise<void> {
    const hold = await this.ledger.get(holdId);
    if (!hold || hold.userId !== userId) throw holdNotFound();
    switch (hold.state) {
      case 'CONFIRMED':
      case 'CONFIRMING':
        throw holdAlreadyConfirmed();
      case 'RELEASED':
      case 'EXPIRED':
        return;
      case 'HELD': {
        const won = await this.ledger.transition(holdId, 'HELD', 'RELEASED');
        if (won) return this.runEffects(hold);
        const now = await this.ledger.get(holdId);
        if (now?.state === 'CONFIRMING' || now?.state === 'CONFIRMED')
          throw holdAlreadyConfirmed();
        return;
      }
    }
  }

  /**
   * The expiry job. Safe late, twice or against a confirm: it acts only on a `HELD` hold whose end has passed by the
   * injected clock (an early or stale job changes nothing).
   */
  async expire(holdId: string): Promise<boolean> {
    const hold = await this.ledger.get(holdId);
    if (!hold || hold.state !== 'HELD') return false;
    return this.expireHold(hold, { requireLapsed: true });
  }

  /** Ends a hold as `EXPIRED`: the job, a late confirm, or the close of the event (`requireLapsed: false`). */
  async expireHold(
    hold: HoldRecord,
    options: { requireLapsed: boolean },
  ): Promise<boolean> {
    const won = await this.ledger.transition(hold.holdId, 'HELD', 'EXPIRED', {
      nowMs: this.clock.nowMs(),
      lapsed: options.requireLapsed ? true : undefined,
    });
    if (!won) return false;
    await this.runEffects(hold);
    return true;
  }

  /**
   * Expires the `HELD` holds of an event: all of them (the event closed, `onlyLapsed: false`) or only those whose end
   * passed (the reconciler's backstop for a lost expiry job). Returns how many this call ended.
   */
  async expireForEvent(
    eventId: string,
    options: { onlyLapsed: boolean },
  ): Promise<number> {
    const nowMs = this.clock.nowMs();
    const ids = new Set<string>();
    for (const record of await this.ledger.records(eventId))
      if (
        record.state === 'HELD' &&
        (!options.onlyLapsed || record.expiresAtMs <= nowMs)
      )
        ids.add(record.holdId);
    let ended = 0;
    for (const holdId of ids) {
      const hold = await this.ledger.get(holdId);
      if (hold?.state !== 'HELD') continue;
      if (await this.expireHold(hold, { requireLapsed: options.onlyLapsed }))
        ended++;
    }
    return ended;
  }

  /** Frees a hold's seats, locks, quota and map bits; each step on its own so one failure does not skip the rest. */
  async runEffects(hold: HoldRecord): Promise<void> {
    const step = async (name: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        launchMetrics.rollbackFailed.add(1);
        this.logger.warn(
          `hold clean-up ${name} failed: ${(error as Error)?.name}`,
        );
      }
    };
    let freed: number[] = [];
    await step('seats', async () => {
      freed = (await this.ledger.freeSeats(hold)).freed;
    });
    await step('locks', () =>
      Promise.all(
        hold.seats.map((seat) =>
          this.locks.release(hold.eventId, seat, hold.holdId),
        ),
      ),
    );
    await step('quota', () =>
      this.quota.credit(hold.eventId, hold.userId, hold.seats.length),
    );
    // Only the seats this hold really gave back: one a newer hold took over keeps its bit.
    await this.seatMap.mark(hold.eventId, freed, 'released');
  }
}

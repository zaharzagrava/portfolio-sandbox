import { Inject, Injectable, Logger } from '@nestjs/common';
import { eventNotFound } from '../domain/errors';
import {
  EVENT_GATE,
  EVENT_REPOSITORY,
  type EventGate,
  type EventRepository,
  type GateRecord,
  type LaunchEventRecord,
} from '../domain/ports';

export const gateOf = (event: LaunchEventRecord): GateRecord => ({
  eventId: event.id,
  shopId: event.shopId,
  status: event.status,
  salesOpenAtMs: event.salesOpenAt.getTime(),
  startsAtMs: event.startsAt.getTime(),
  seatCount: event.seatCount,
  seatsPerRow: event.seatsPerRow,
  seatingMode: event.seatingMode,
  perUserLimit: event.perUserLimit,
  admissionRatePerSec: event.admissionRatePerSec,
  humanCheckRequired: event.humanCheckRequired,
});

/**
 * The event facts the hot paths decide on (D-7): the Redis gate when it is there, the row when it is not (and then the
 * gate is written back). Every status change refreshes the gate, so the cached public page never decides (AS-20).
 */
@Injectable()
export class EventGateService {
  private readonly logger = new Logger(EventGateService.name);

  constructor(
    @Inject(EVENT_GATE) private readonly gate: EventGate,
    @Inject(EVENT_REPOSITORY) private readonly events: EventRepository,
  ) {}

  /**
   * `strict`: a gate store failure propagates (the waiting room must touch no other store); otherwise it falls back
   * to the row, because a hold must stay correct with the fast store down.
   */
  async require(
    eventId: string,
    options: { strict?: boolean } = {},
  ): Promise<GateRecord> {
    let cached: GateRecord | null = null;
    try {
      cached = await this.gate.get(eventId);
    } catch (error) {
      if (options.strict) throw error;
    }
    if (cached) return cached;
    const event = await this.events.findById(eventId);
    if (!event) throw eventNotFound();
    const record = gateOf(event);
    await this.gate.put(record).catch(() => undefined);
    return record;
  }

  /** After a status change: the gate follows at once. A failure leaves the gate stale for its short TTL, never longer. */
  async refresh(event: LaunchEventRecord): Promise<void> {
    try {
      await this.gate.put(gateOf(event));
    } catch (error) {
      this.logger.warn(`gate refresh failed: ${(error as Error)?.name}`);
    }
  }
}

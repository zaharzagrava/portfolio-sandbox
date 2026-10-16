import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  createLaunchEventRequestSchema,
  type LaunchEventDto,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { CacheService } from '@app/infrastructure/cache';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import {
  CLOSE_EVENT_JOB,
  OPEN_SALES_JOB,
  closeEventJobKey,
  openSalesJobKey,
} from '../domain/constants';
import {
  eventAlreadyClosed,
  eventNotFound,
  invalidSchedule,
  validationFailed,
} from '../domain/errors';
import { canTransitionEvent } from '../domain/event-state';
import {
  DEFAULT_ADMISSION_RATE,
  DEFAULT_PER_USER_LIMIT,
  defaultSeatsPerRow,
  isValidSchedule,
} from '../domain/schedule';
import {
  EVENT_REPOSITORY,
  QUEUE_STORE,
  type ClosedReason,
  type EventRepository,
  type LaunchEventRecord,
  type QueueStore,
} from '../domain/ports';
import { fieldIssues } from '../domain/field-issues';
import './launch-event.job-types';
import { EventGateService } from './event-gate.service';
import { HoldLifecycleService } from './hold-lifecycle.service';
import { LaunchEventOutbox } from './launch-event-outbox';

export const toLaunchEventDto = (event: LaunchEventRecord): LaunchEventDto => ({
  id: event.id,
  shopId: event.shopId,
  title: event.title,
  venue: event.venue,
  startsAt: event.startsAt.toISOString(),
  salesOpenAt: event.salesOpenAt.toISOString(),
  seatCount: event.seatCount,
  seatsPerRow: event.seatsPerRow,
  seatingMode: event.seatingMode,
  perUserLimit: event.perUserLimit,
  humanCheckRequired: event.humanCheckRequired,
  status: event.status,
});

export const eventPageKey = (eventId: string) => `launch-event:v2:${eventId}`;

/**
 * The launch event and its status machine (FR-041, FR-043): create, organizer close, the sales-opening and start-time
 * closes. Every status change is `UPDATE … WHERE status = :from` with its history row and event in one transaction;
 * the gate and the cached page follow it right after the commit.
 */
@Injectable()
export class LaunchEventService {
  private readonly logger = new Logger(LaunchEventService.name);

  constructor(
    @Inject(EVENT_REPOSITORY) private readonly events: EventRepository,
    @Inject(QUEUE_STORE) private readonly queue: QueueStore,
    private readonly outbox: LaunchEventOutbox,
    private readonly gates: EventGateService,
    private readonly holds: HoldLifecycleService,
    private readonly jobs: JobsService,
    private readonly cache: CacheService,
    private readonly tx: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(shopId: string, body: unknown): Promise<LaunchEventDto> {
    const parsed = createLaunchEventRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw validationFailed(fieldIssues(parsed.error));
    const input = parsed.data;
    const seatsPerRow =
      input.seatsPerRow ?? defaultSeatsPerRow(input.seatCount);
    if (seatsPerRow > input.seatCount)
      throw validationFailed([{ field: 'seatsPerRow', code: 'too_big' }]);
    const startsAt = new Date(input.startsAt);
    const salesOpenAt = new Date(input.salesOpenAt);
    if (
      !isValidSchedule({
        nowMs: this.clock.nowMs(),
        salesOpenAtMs: salesOpenAt.getTime(),
        startsAtMs: startsAt.getTime(),
      })
    )
      throw invalidSchedule();

    const event = await this.tx.run(async () => {
      const created = await this.events.create({
        shopId,
        title: input.title,
        venue: input.venue,
        startsAt,
        salesOpenAt,
        seatCount: input.seatCount,
        seatsPerRow,
        seatingMode: input.seatingMode ?? 'SEATED',
        perUserLimit: input.perUserLimit ?? DEFAULT_PER_USER_LIMIT,
        admissionRatePerSec:
          input.admissionRatePerSec ?? DEFAULT_ADMISSION_RATE,
        humanCheckRequired: input.humanCheckRequired ?? false,
      });
      await this.outbox.created(created);
      await this.jobs.enqueue(
        OPEN_SALES_JOB,
        { eventId: created.id },
        { runAt: salesOpenAt, idempotencyKey: openSalesJobKey(created.id) },
      );
      await this.jobs.enqueue(
        CLOSE_EVENT_JOB,
        { eventId: created.id, reason: 'started' },
        {
          runAt: startsAt,
          idempotencyKey: closeEventJobKey(created.id, 'started'),
        },
      );
      return created;
    });
    await this.gates.refresh(event);
    return toLaunchEventDto(event);
  }

  /** The public event page, cached with single flight and a short negative cache (AS-49). */
  async page(eventId: string): Promise<LaunchEventDto> {
    const dto = await this.cache.getOrLoad<LaunchEventDto>(
      eventPageKey(eventId),
      async () => {
        const event = await this.events.findById(eventId);
        return event ? toLaunchEventDto(event) : null;
      },
      { ttlMs: 60_000, negativeTtlMs: 5_000, l1: 'always', l1TtlMs: 1_000 },
    );
    if (!dto) throw eventNotFound();
    return dto;
  }

  /** Organizer close. The event must be the shop's own (`404` otherwise, identical to an unknown event). */
  async close(shopId: string, eventId: string): Promise<LaunchEventDto> {
    const event = await this.events.findById(eventId);
    if (!event || event.shopId !== shopId) throw eventNotFound();
    const closed = await this.closeEvent(event, 'organizer');
    if (!closed) throw eventAlreadyClosed();
    const after = await this.events.findById(eventId);
    return toLaunchEventDto(after ?? { ...event, status: 'CLOSED' });
  }

  /**
   * Moves any open event to `CLOSED`; `false` when it already was (or another call closed it first). The clean-up of a
   * close runs in the `close-event` job (and the reconciler), not in the request.
   */
  async closeEvent(
    event: LaunchEventRecord,
    reason: ClosedReason,
  ): Promise<boolean> {
    if (!canTransitionEvent(event.status, 'CLOSED')) return false;
    const won = await this.tx.run(async () => {
      const moved = await this.events.transition(
        event.id,
        event.status,
        'CLOSED',
        { reason, closedReason: reason },
      );
      if (moved) await this.outbox.closed(event, reason);
      return moved;
    });
    if (!won) {
      // Somebody moved it between our read and our update: if it is closed now, we lost the race; else try again.
      const current = await this.events.findById(event.id);
      if (!current || current.status === 'CLOSED') return false;
      return this.closeEvent(current, reason);
    }
    await this.afterChange(event.id);
    await this.queue.clear(event.id).catch(() => undefined);
    await this.jobs
      .enqueue(
        CLOSE_EVENT_JOB,
        { eventId: event.id, reason },
        { idempotencyKey: closeEventJobKey(event.id, `${reason}:cleanup`) },
      )
      .catch((error) =>
        this.logger.warn(`close clean-up job not queued: ${error?.name}`),
      );
    return true;
  }

  /** `open-sales`: `SCHEDULED → ON_SALE` once, at or after `salesOpenAt`; anything else changes nothing. */
  async openSales(eventId: string): Promise<boolean> {
    const event = await this.events.findById(eventId);
    if (!event || event.status !== 'SCHEDULED') return false;
    if (this.clock.nowMs() < event.salesOpenAt.getTime()) return false;
    const won = await this.events.transition(eventId, 'SCHEDULED', 'ON_SALE', {
      reason: 'sales_open',
    });
    if (won) await this.afterChange(eventId);
    return won;
  }

  /** The `close-event` job: closes on `started`, then ends every open hold and clears the waiting room (idempotent). */
  async runClose(
    eventId: string,
    reason: ClosedReason,
  ): Promise<{ closed: boolean; holdsEnded: number }> {
    const event = await this.events.findById(eventId);
    if (!event) return { closed: false, holdsEnded: 0 };
    let closed = false;
    if (reason === 'started' && event.status !== 'CLOSED')
      closed = await this.closeEvent(event, 'started');
    const current = await this.events.findById(eventId);
    if (current?.status !== 'CLOSED') return { closed, holdsEnded: 0 };
    await this.queue.clear(eventId).catch(() => undefined);
    const holdsEnded = await this.holds.expireForEvent(eventId, {
      onlyLapsed: false,
    });
    return { closed, holdsEnded };
  }

  /** After a committed status change: the gate and the cached page follow. */
  async afterChange(eventId: string): Promise<void> {
    const event = await this.events.findById(eventId);
    if (event) await this.gates.refresh(event);
    await this.cache.invalidate([eventPageKey(eventId)]);
  }
}

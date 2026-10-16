import { Injectable } from '@nestjs/common';
import {
  BOOKING_VOUCHER_COMMAND,
  type bookingVoucherRequestedSchema,
} from '@marketplace-sandbox/contracts';
import type { z } from 'zod';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { BOOKING_VOUCHER_QUEUE, voucherDedupeKey } from '../domain/constants';
import type { LaunchEventRecord } from '../domain/ports';
import {
  BookingConfirmed,
  LaunchEventClosed,
  LaunchEventCreated,
  LaunchEventSoldOut,
} from './events/launch-event-events';

type VoucherCommand = z.infer<typeof bookingVoucherRequestedSchema>;

/**
 * Writes the S22 events and the voucher command on the outbox, in the caller's transaction (IX.6): the state change and
 * its event commit or roll back together. Nothing here talks to a broker or a queue.
 */
@Injectable()
export class LaunchEventOutbox {
  constructor(private readonly outbox: OutboxService) {}

  created(event: LaunchEventRecord): Promise<void> {
    return this.outbox.append(
      LaunchEventCreated.create(event.id, 1, {
        launchEventId: event.id,
        shopId: event.shopId,
        title: event.title,
        startsAt: event.startsAt.toISOString(),
        salesOpenAt: event.salesOpenAt.toISOString(),
        seatCount: event.seatCount,
      }),
    );
  }

  bookingConfirmed(input: {
    holdId: string;
    event: LaunchEventRecord;
    userId: string;
    seats: number[];
    bookingIds: string[];
    confirmedAt: Date;
  }): Promise<void> {
    return this.outbox.append(
      BookingConfirmed.create(input.holdId, 1, {
        holdId: input.holdId,
        launchEventId: input.event.id,
        shopId: input.event.shopId,
        userId: input.userId,
        seats: input.seats,
        bookingIds: input.bookingIds,
        confirmedAt: input.confirmedAt.toISOString(),
      }),
    );
  }

  soldOut(event: LaunchEventRecord): Promise<void> {
    return this.outbox.append(
      LaunchEventSoldOut.create(event.id, 1, {
        launchEventId: event.id,
        shopId: event.shopId,
      }),
    );
  }

  closed(
    event: LaunchEventRecord,
    reason: 'organizer' | 'started',
  ): Promise<void> {
    return this.outbox.append(
      LaunchEventClosed.create(event.id, 1, {
        launchEventId: event.id,
        shopId: event.shopId,
        reason,
      }),
    );
  }

  /** Best-effort command to `orders` (S10): a booking never waits on it (FR-035). */
  voucherRequested(command: Omit<VoucherCommand, 'dedupeKey'>): Promise<void> {
    return this.outbox.appendTask({
      queue: BOOKING_VOUCHER_QUEUE,
      type: BOOKING_VOUCHER_COMMAND,
      aggregateId: command.holdId,
      body: { ...command, dedupeKey: voucherDedupeKey(command.holdId) },
    });
  }
}

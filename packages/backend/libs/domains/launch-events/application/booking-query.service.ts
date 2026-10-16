import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type {
  bookingPageSchema,
  myBookingsSchema,
} from '@marketplace-sandbox/contracts';
import { eventNotFound, validationFailed } from '../domain/errors';
import {
  BOOKING_REPOSITORY,
  EVENT_REPOSITORY,
  type BookingCursor,
  type BookingRepository,
  type EventRepository,
} from '../domain/ports';

type BookingPage = z.infer<typeof bookingPageSchema>;
type MyBookings = z.infer<typeof myBookingsSchema>;

export const encodeCursor = (cursor: BookingCursor): string =>
  Buffer.from(JSON.stringify([cursor.confirmedAt, cursor.id])).toString(
    'base64url',
  );

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An opaque cursor from this service; anything else is `400 validation_failed` on `cursor`. */
export const decodeCursor = (raw: string): BookingCursor => {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      ISO.test(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      UUID.test(parsed[1])
    )
      return { confirmedAt: parsed[0], id: parsed[1] };
  } catch {
    // fall through
  }
  throw validationFailed([{ field: 'cursor', code: 'invalid' }]);
};

/** Booking reads (FR-037, FR-042, FR-045): every lookup carries the principal in its predicate. */
@Injectable()
export class BookingQueryService {
  constructor(
    @Inject(BOOKING_REPOSITORY) private readonly bookings: BookingRepository,
    @Inject(EVENT_REPOSITORY) private readonly events: EventRepository,
  ) {}

  /** The organizer's page, newest first. An event of another shop is `404`, identical to an unknown one. */
  async forShop(
    shopId: string,
    eventId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<BookingPage> {
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const event = await this.events.findById(eventId);
    if (!event || event.shopId !== shopId) throw eventNotFound();
    const rows = await this.bookings.page(eventId, limit + 1, after);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        bookingId: row.id,
        holdId: row.holdId,
        seat: row.seat,
        userId: row.userId,
        confirmedAt: row.confirmedAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              confirmedAt: last.confirmedAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  async mine(eventId: string, userId: string): Promise<MyBookings> {
    if (!(await this.events.findById(eventId))) throw eventNotFound();
    const rows = await this.bookings.forUser(eventId, userId);
    return {
      items: rows.map((row) => ({
        bookingId: row.id,
        seat: row.seat,
        confirmedAt: row.confirmedAt.toISOString(),
      })),
    };
  }
}

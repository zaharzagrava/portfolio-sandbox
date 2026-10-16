import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { QueryTypes, UniqueConstraintError } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  SeatConflictError,
  type BookingCursor,
  type BookingRecord,
  type BookingRepository,
} from '../domain/ports';
import Booking from './models/booking.model';
import BookingEvent from './models/booking-event.model';

const toRecord = (row: Booking): BookingRecord => ({
  id: row.id,
  eventId: row.eventId,
  seat: row.seat,
  userId: row.userId,
  holdId: row.holdId,
  confirmedAt: new Date(row.confirmedAt),
});

const COLUMNS = `"id", "eventId", "seat", "userId", "holdId", "confirmedAt"`;

/** The seat of a violated "Booking_one_confirmed_per_seat" from the database's own message. */
const conflictingSeat = (error: UniqueConstraintError): number | undefined => {
  const detail = (error.parent as { detail?: string } | undefined)?.detail;
  const seat = detail?.match(/, (\d+)\) already exists/)?.[1];
  return seat === undefined ? undefined : Number(seat);
};

@Injectable()
export class SequelizeBookingRepository implements BookingRepository {
  constructor(
    @InjectModel(Booking) private readonly bookings: typeof Booking,
    @InjectModel(BookingEvent)
    private readonly bookingEvents: typeof BookingEvent,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  async forHold(holdId: string): Promise<BookingRecord[]> {
    const rows = await this.bookings.findAll({
      where: { holdId, status: 'CONFIRMED' },
      order: [['seat', 'ASC']],
    });
    return rows.map(toRecord);
  }

  async insertConfirmed(input: {
    eventId: string;
    holdId: string;
    userId: string;
    seats: number[];
    at: Date;
  }): Promise<BookingRecord[]> {
    let rows: Booking[];
    try {
      rows = await this.bookings.bulkCreate(
        input.seats.map((seat) => ({
          eventId: input.eventId,
          seat,
          userId: input.userId,
          holdId: input.holdId,
          status: 'CONFIRMED' as const,
          confirmedAt: input.at,
        })),
        { returning: true },
      );
    } catch (error) {
      if (error instanceof UniqueConstraintError)
        throw new SeatConflictError(conflictingSeat(error));
      throw error;
    }
    await this.bookingEvents.bulkCreate(
      rows.map((row) => ({
        bookingId: row.id,
        fromStatus: null,
        toStatus: 'CONFIRMED',
        holdId: input.holdId,
        at: input.at,
      })),
    );
    return rows.map(toRecord);
  }

  async seatsOfUser(eventId: string, userId: string): Promise<number[]> {
    const rows = await this.bookings.findAll({
      attributes: ['seat'],
      where: { eventId, userId, status: 'CONFIRMED' },
    });
    return rows.map((row) => row.seat);
  }

  count(eventId: string): Promise<number> {
    return this.bookings.count({ where: { eventId, status: 'CONFIRMED' } });
  }

  async confirmedSeats(eventId: string): Promise<BookingRecord[]> {
    const rows = await this.bookings.findAll({
      where: { eventId, status: 'CONFIRMED' },
      order: [['seat', 'ASC']],
    });
    return rows.map(toRecord);
  }

  async page(
    eventId: string,
    limit: number,
    after: BookingCursor | null,
  ): Promise<BookingRecord[]> {
    const rows = await this.sequelize.query<Booking>(
      `SELECT ${COLUMNS} FROM "Booking"
        WHERE "eventId" = :eventId AND "status" = 'CONFIRMED'
          ${after ? `AND ("confirmedAt", "id") < (:at::timestamptz, :id::uuid)` : ''}
        ORDER BY "confirmedAt" DESC, "id" DESC
        LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: { eventId, limit, at: after?.confirmedAt, id: after?.id },
      },
    );
    return rows.map((row) => toRecord(row as Booking));
  }

  async forUser(eventId: string, userId: string): Promise<BookingRecord[]> {
    const rows = await this.bookings.findAll({
      where: { eventId, userId, status: 'CONFIRMED' },
      order: [
        ['confirmedAt', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    return rows.map(toRecord);
  }

  async countDoubleBooked(): Promise<number> {
    const [row] = await this.sequelize.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT 1 FROM "Booking" WHERE "status" = 'CONFIRMED'
          GROUP BY "eventId", "seat" HAVING count(*) > 1) d`,
      { type: QueryTypes.SELECT },
    );
    return Number(row?.n ?? 0);
  }
}

import { randomUUID } from 'node:crypto';
import {
  confirmResponseSchema,
  holdSchema,
  myBookingsSchema,
  seatMapSchema,
  type ConfirmResponseDto,
  type HoldDto,
  type LaunchEventDto,
  launchEventSchema,
} from '@marketplace-sandbox/contracts';
import type { LaunchFixture } from './launch-fixture';
import type { JourneyClient } from './journey-client';
import { waitForContract } from './wait-for-contract';

/** The seats that are taken (held or booked) in a base64 bitmap: seat `i` is bit `7 - i % 8` of byte `i / 8`. */
export function takenSeats(bitmap: string, seatCount: number): number[] {
  const bytes = Buffer.from(bitmap, 'base64');
  const taken: number[] = [];
  for (let seat = 0; seat < seatCount; seat++)
    if ((bytes[Math.floor(seat / 8)] ?? 0) & (1 << (7 - (seat % 8))))
      taken.push(seat);
  return taken;
}

export async function seatMap(
  client: JourneyClient,
  eventId: string,
): Promise<{ seq: number; taken: number[] }> {
  const reply = await client.get(`/api/launch-events/${eventId}/seatmap`, {
    schema: seatMapSchema,
  });
  if (reply.status !== 200)
    throw new Error(`seatmap: ${reply.status} ${JSON.stringify(reply.body)}`);
  const map = reply.body;
  return { seq: map.seq, taken: takenSeats(map.bitmap, map.seatCount) };
}

export async function getEvent(
  client: JourneyClient,
  eventId: string,
): Promise<LaunchEventDto> {
  const reply = await client.get(`/api/launch-events/${eventId}`, {
    schema: launchEventSchema,
  });
  if (reply.status !== 200)
    throw new Error(`event: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body as LaunchEventDto;
}

/** A buyer who stood in the queue and holds an admission token. */
export interface Admitted {
  buyer: JourneyClient;
  ticket: string;
  token: string;
}

/**
 * Joins the queue and waits for the admission (H2). The event must be on sale (or about to be: the wait covers the
 * opening); the admitter runs at the event's rate, so wait for fewer buyers than the rate per second at a time.
 */
export async function admit(
  fixture: LaunchFixture,
  buyer: JourneyClient,
  eventId: string,
): Promise<Admitted> {
  const joined = await fixture.joinQueue(buyer, eventId);
  const status = await waitForContract(
    'J03.H2',
    async () => {
      const s = await fixture.ticketStatus(buyer, eventId, joined.ticket);
      return s.admitted && s.admissionToken ? s : null;
    },
    `ticket of ${buyer.label} admitted`,
  );
  return { buyer, ticket: joined.ticket, token: status.admissionToken! };
}

/** `POST /launch-events/:id/holds` with the admission token; returns the reply so a test can assert refusals. */
export function holdSeats(
  who: Admitted,
  eventId: string,
  seats: number[],
  key: string = randomUUID(),
  token: string = who.token,
) {
  return who.buyer.post(`/api/launch-events/${eventId}/holds`, {
    body: { seats },
    key,
    headers: { 'x-admission-token': token },
    schema: holdSchema,
  });
}

export async function mustHold(
  who: Admitted,
  eventId: string,
  seats: number[],
  key?: string,
): Promise<HoldDto> {
  const reply = await holdSeats(who, eventId, seats, key);
  if (reply.status !== 201)
    throw new Error(`hold: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body as HoldDto;
}

/** `POST /launch-holds/:id/confirm`; the reply is returned so a test can assert `201`, `200` or a refusal. */
export function confirmHold(
  buyer: JourneyClient,
  holdId: string,
  key: string = randomUUID(),
) {
  return buyer.post(`/api/launch-holds/${holdId}/confirm`, {
    key,
    schema: confirmResponseSchema,
  });
}

export async function mustConfirm(
  buyer: JourneyClient,
  holdId: string,
  key?: string,
): Promise<ConfirmResponseDto> {
  const reply = await confirmHold(buyer, holdId, key);
  if (reply.status !== 201 && reply.status !== 200)
    throw new Error(`confirm: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body as ConfirmResponseDto;
}

export async function myBookings(buyer: JourneyClient, eventId: string) {
  const reply = await buyer.get(`/api/launch-events/${eventId}/my-bookings`, {
    schema: myBookingsSchema,
  });
  if (reply.status !== 200)
    throw new Error(`my-bookings: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body.items;
}

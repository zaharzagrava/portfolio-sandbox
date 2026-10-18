import { API_URL, type JourneyClient } from './journey-client';
import { openSse, openStream, type OpenStream } from './stream';
import { deadlineMs, type Hop } from './wait-for-contract';

export type { OpenStream, StreamEvent } from './stream';

/** The topics of launch day (spec.md "Notation"); a typo here is a compile error, not a silent empty stream. */
export const topics = {
  queue: (ticket: string) => `queue:${ticket}`,
  seatMap: (eventId: string) => `event:${eventId}:seatmap`,
  auction: (auctionId: string) => `auction:${auctionId}`,
  stream: (streamId: string) => `stream:${streamId}`,
  user: (userId: string) => `user:${userId}`,
} as const;

/** `GET /api/streams?topics=…` for one or several topics, as `actor` (the gateway checks every topic against the principal). */
export function sseClient(
  actor: JourneyClient,
  ...subscribed: string[]
): Promise<OpenStream> {
  return openStream(actor, subscribed.join(','));
}

/** The viewer connection of a live stream, `GET /api/live/:id/events` (anonymous, or as `actor`). */
export function liveViewer(
  streamId: string,
  actor?: JourneyClient,
): Promise<OpenStream> {
  return openSse(
    `${API_URL}/api/live/${streamId}/events`,
    actor?.token ? { authorization: `Bearer ${actor.token}` } : {},
  );
}

/** The first event of `type` (and `where`) on the stream, within the deadline of `hop`. */
export function expectEvent(
  stream: OpenStream,
  hop: Hop,
  type: string,
  where: (data: Record<string, unknown>) => boolean = () => true,
) {
  return stream.next(
    (e) => e.event === type && where(e.data),
    deadlineMs(hop),
    `${type} (${hop})`,
  );
}

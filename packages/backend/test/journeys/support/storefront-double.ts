import { randomUUID } from 'node:crypto';
import type { JourneyClient } from './journey-client';
import { API_URL } from './journey-client';

/** One analytics event as the storefront would send it. */
export interface StorefrontEvent {
  name: 'page_view' | 'product_view' | 'add_to_cart' | 'exposure' | 'click';
  /** Visitor id of the event: 8-64 characters of `[A-Za-z0-9_-]`. */
  anonymousId: string;
  props?: Record<string, string | number | boolean>;
  /** A fixed id makes a resend a duplicate; the default is a fresh one per event. */
  eventId?: string;
  /** Epoch milliseconds; default now. */
  ts?: number;
}

export interface IngestReply {
  status: number;
  accepted?: number;
  rejected?: { index: number; code: string }[];
}

/** A visitor id of the shape the collector accepts, unique to the run. */
export const visitorId = (label = 'v') =>
  `${label}-${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/**
 * The storefront as a test double (J05 G-19): the web app does not emit analytics yet, so the journey posts the same batches
 * to `POST /api/events`. `token` makes the batch a signed-in one (the collector reads `user_id` from the principal only).
 */
export const storefrontDouble = {
  async post(
    events: StorefrontEvent[],
    options: { token?: string | null } = {},
  ): Promise<IngestReply> {
    const response = await fetch(`${API_URL}/api/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.token && { authorization: `Bearer ${options.token}` }),
      },
      body: JSON.stringify({
        events: events.map((e) => ({
          event_id: e.eventId ?? randomUUID(),
          name: e.name,
          anonymous_id: e.anonymousId,
          ts: e.ts ?? Date.now(),
          ...(e.props && { props: e.props }),
        })),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      accepted?: number;
      rejected?: { index: number; code: string }[];
    };
    return { status: response.status, ...body };
  },

  /** The same, as a signed-in visitor. */
  postAs(client: JourneyClient, events: StorefrontEvent[]) {
    return storefrontDouble.post(events, { token: client.token });
  },
};

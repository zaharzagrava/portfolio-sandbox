import {
  topicMessagePageSchema,
  type TopicMessage,
} from '@marketplace-sandbox/contracts';
import { adminClient, ControlSurface } from './control-surface';
import type { JourneyClient } from './journey-client';
import { type Hop, waitForContract } from './wait-for-contract';

export interface TapFilter {
  type?: string;
  key?: string;
  limit?: number;
}

let operator: Promise<JourneyClient> | undefined;
const admin = () => (operator ??= adminClient());

/**
 * Read-only view of the events the relay published to `topic` (J03 G-41): `GET /api/admin/topics/:topic/messages`. Only
 * for the facts no consumer reads (stream, drop and event lifecycle) and for "exactly once" proofs; it never drives
 * anything. The page is parsed with the contract schema.
 */
export async function eventTap(
  topic: string,
  filter: TapFilter = {},
): Promise<TopicMessage[]> {
  const reply = await (await admin()).get(`/api/admin/topics/${topic}/messages`, {
    query: { ...filter, limit: filter.limit ?? 200 },
    schema: topicMessagePageSchema,
  });
  if (reply.status !== 200)
    throw new Error(
      `event tap ${topic}: ${reply.status} (is the stack started with EVENT_TAP=enabled?) ${JSON.stringify(reply.body)}`,
    );
  return reply.body.items;
}

/** Waits until at least `atLeast` events match, within the deadline of `hop`, and returns them. */
export function tapUntil(
  hop: Hop,
  topic: string,
  filter: TapFilter,
  atLeast = 1,
): Promise<TopicMessage[]> {
  return waitForContract(
    hop,
    async () => {
      const items = await eventTap(topic, filter);
      return items.length >= atLeast ? items : null;
    },
    `${topic} ${filter.type ?? '*'} ${filter.key ?? ''}`.trim(),
  );
}

/**
 * "Exactly once": the number of events of `type` for `key` on `topic`, read only once the given consumer groups have
 * caught up (lag 0), so a late duplicate cannot hide behind a slow relay. Returns the matching events.
 */
export async function countExactlyOnce(
  controls: ControlSurface,
  topic: string,
  type: string,
  key: string,
  groups: readonly string[] = [],
): Promise<TopicMessage[]> {
  for (const group of groups) await controls.waitCaughtUp(group);
  return eventTap(topic, { type, key });
}

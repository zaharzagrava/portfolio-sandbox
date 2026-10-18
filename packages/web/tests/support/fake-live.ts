import type { TopicEvent } from '@/lib/realtime/user-stream';

/**
 * W05 test support (gaps T2, T7): a controllable stand-in for `subscribeTopic` of `lib/realtime/user-stream.ts`, for the
 * tests of the chat live hook. Use with `vi.mock('@/lib/realtime/user-stream', ...)` and `fakeLive.subscribeTopic`.
 * It records which topics are held (with a count), and the test pushes hub frames, `resync` and `revoked` by hand.
 */
export type FakeLive = {
  subscribeTopic: (topic: string, handler: (event: TopicEvent) => void, eventTypes?: string[]) => () => void;
  /** Topics currently held, sorted. */
  held: () => string[];
  /** Every `subscribeTopic` call since creation, in order (released ones included). */
  subscribed: () => string[];
  /** The event types asked for a topic. */
  typesOf: (topic: string) => string[];
  /** A hub frame of `type` for `topic`. */
  emit: (topic: string, type: string, data: unknown) => void;
  /** The replay window was lost, or the stream reconnected: delivered to every holder. */
  resync: () => void;
  /** The server dropped `topic`: delivered to its holders and the topic is released. */
  revoked: (topic: string) => void;
};

export function createFakeLive(): FakeLive {
  type Holder = { topic: string; handler: (event: TopicEvent) => void; types: string[] };
  const holders = new Set<Holder>();
  const calls: string[] = [];
  return {
    subscribeTopic(topic, handler, eventTypes = []) {
      const holder: Holder = { topic, handler, types: eventTypes };
      holders.add(holder);
      calls.push(topic);
      return () => {
        holders.delete(holder);
      };
    },
    held: () => [...new Set([...holders].map((holder) => holder.topic))].sort(),
    subscribed: () => [...calls],
    typesOf: (topic) => [...new Set([...holders].filter((holder) => holder.topic === topic).flatMap((holder) => holder.types))],
    emit: (topic, type, data) => {
      for (const holder of [...holders]) if (holder.topic === topic) holder.handler({ type, data });
    },
    resync: () => {
      for (const holder of [...holders]) holder.handler({ type: 'resync', data: null });
    },
    revoked: (topic) => {
      for (const holder of [...holders]) {
        if (holder.topic !== topic) continue;
        holder.handler({ type: 'revoked', data: topic });
        holders.delete(holder);
      }
    },
  };
}

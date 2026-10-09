/**
 * Realtime topics (F-03): `<prefix>:<id>[:<suffix>]` strings, or a bare singleton prefix. Which prefixes exist and
 * who may subscribe is defined by the owning domains in `TopicRegistry` (debt D-3), not here.
 */
export type RealtimeTopic = string;

export const MAX_TOPICS_PER_CONNECTION = 10;

/** Short replay window per topic: enough for reconnects, bounded memory. */
export const REPLAY_MAXLEN = 1_000;

export const streamKey = (topic: string) => `rt:stream:{${topic}}`;
export const channelName = (topic: string) => `rt:ch:${topic}`;

export interface RealtimeMessage<T = unknown> {
  /** Redis Stream entry id - monotonically increasing per topic; the SSE cursor. */
  id: string;
  topic: RealtimeTopic;
  type: string;
  data: T;
}

/**
 * The SSE `id:` field carries a cursor for ALL topics of the connection
 * (`topic~streamId|topic~streamId`), because the browser sends back a single
 * Last-Event-ID on reconnect.
 */
export function encodeCursor(cursor: Map<string, string>): string {
  return [...cursor.entries()].map(([t, id]) => `${t}~${id}`).join('|');
}

export function decodeCursor(
  raw: string | undefined,
  isKnownTopic: (topic: string) => boolean,
): Map<string, string> {
  const cursor = new Map<string, string>();
  if (!raw) return cursor;
  for (const part of raw.split('|')) {
    const [topic, id] = part.split('~');
    if (topic && /^\d+-\d+$/.test(id ?? '') && isKnownTopic(topic))
      cursor.set(topic, id);
  }
  return cursor;
}

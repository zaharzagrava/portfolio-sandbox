/**
 * Realtime topics (F-03): `<prefix>:<id>[:<suffix>]`, or a bare singleton prefix. Which routes exist and who may
 * subscribe is defined by the owning domains in `TopicRegistry` (debt D-3), not here. Everything in this file is pure
 * (time and randomness are arguments), so the grammar, the cursor and the resync decision are unit-tested as tables.
 */
/**
 * The known routes as template-literal types, keyed by route (`prefix` or `prefix:suffix`). Owners add theirs by module
 * augmentation next to their `TopicRegistry.define` call (FR-024, AS-34):
 * `declare module '@app/infrastructure/realtime' { interface RealtimeTopicPrefixes { auction: `auction:${string}` } }`
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- extended by each owner's module augmentation
export interface RealtimeTopicPrefixes {}

/** A topic whose route some domain declared; anything else does not compile. */
export type RealtimeTopic = RealtimeTopicPrefixes[keyof RealtimeTopicPrefixes] &
  string;

export interface RealtimeMessage<T = unknown> {
  /** Redis Stream entry id - monotonically increasing per topic; the SSE cursor. `0-0` for live-only messages. */
  id: string;
  topic: string;
  type: string;
  data: T;
}

export const LIVE_ONLY_ID = '0-0';

const PREFIX = /^[a-z][a-z-]{0,31}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const POSITION = /^\d{1,16}-\d{1,16}$/;
export const CURSOR_MAX_LENGTH = 2_048;
export const CURSOR_FUTURE_TOLERANCE_MS = 60_000;

export const isValidPrefix = (value: string) => PREFIX.test(value);

export interface TopicShape {
  prefix: string;
  id: string | null;
  suffix: string | null;
}

/** Grammar only; whether anyone defined the route is `resolveRoute`. */
export function parseTopicShape(topic: string): TopicShape | null {
  const parts = topic.split(':');
  if (parts.length > 3) return null;
  const [prefix, id = null, suffix = null] = parts;
  if (!PREFIX.test(prefix)) return null;
  if (parts.length === 1) return { prefix, id: null, suffix: null };
  if (id === null || !ID.test(id)) return null;
  if (suffix !== null && !PREFIX.test(suffix)) return null;
  return { prefix, id, suffix };
}

/** Route key -> whether the route is a singleton (`flags`). Route keys are `prefix` or `prefix:suffix`. */
export type RouteTable = ReadonlyMap<string, { singleton: boolean }>;

export interface ResolvedRoute {
  key: string;
  prefix: string;
  id: string;
  suffix: string | null;
}

export function resolveRoute(
  topic: string,
  routes: RouteTable,
): ResolvedRoute | null {
  const shape = parseTopicShape(topic);
  if (!shape) return null;
  const key = shape.suffix ? `${shape.prefix}:${shape.suffix}` : shape.prefix;
  const route = routes.get(key);
  if (!route) return null;
  if (shape.id === null)
    return route.singleton
      ? { key, prefix: shape.prefix, id: '', suffix: null }
      : null;
  if (route.singleton) return null;
  return { key, prefix: shape.prefix, id: shape.id, suffix: shape.suffix };
}

/** Redis Stream ids are `<ms>-<seq>`; compare numerically. */
export function comparePositions(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am - bm || as - bs;
}

const timeOf = (position: string) => Number(position.split('-')[0]);

/**
 * The SSE `id:` carries a cursor for ALL topics of the connection (`topic~position|topic~position`), because the
 * browser sends back a single Last-Event-ID on reconnect.
 */
export function encodeCursor(cursor: ReadonlyMap<string, string>): string {
  return [...cursor.entries()].map(([t, id]) => `${t}~${id}`).join('|');
}

export interface DecodedCursor {
  cursor: Map<string, string>;
  /** Unusable entries (or 1 for a header that is too long), for the ignored-cursor counter. */
  ignored: number;
}

/** Usable entries only: requested topic, valid shape, not `0-0`, not far in the future; the first entry per topic wins. */
export function decodeCursor(
  raw: string | undefined,
  options: { isRequested: (topic: string) => boolean; now: number },
): DecodedCursor {
  const cursor = new Map<string, string>();
  if (!raw) return { cursor, ignored: 0 };
  if (raw.length > CURSOR_MAX_LENGTH) return { cursor, ignored: 1 };
  let ignored = 0;
  for (const part of raw.split('|')) {
    const [topic, position, ...rest] = part.split('~');
    const usable =
      !!topic &&
      !!position &&
      rest.length === 0 &&
      POSITION.test(position) &&
      position !== LIVE_ONLY_ID &&
      timeOf(position) <= options.now + CURSOR_FUTURE_TOLERANCE_MS &&
      options.isRequested(topic) &&
      !cursor.has(topic);
    if (usable) cursor.set(topic, position);
    else ignored++;
  }
  return { cursor, ignored };
}

export const retentionCutoffMs = (now: number, retentionMs: number) =>
  Math.max(0, now - retentionMs);

export interface ReplayInput {
  cursor: string;
  now: number;
  retentionMs: number;
  /** The topic's replay buffer exists. */
  exists: boolean;
  /** Position of the newest stored entry (`0-0` when none). */
  latestId: string;
  /** Highest position the store ever trimmed or expired for this buffer (`0-0` when none). */
  maxDeletedId: string;
}

/**
 * Can the hub prove that nothing after `cursor` was lost? `replay`: read `(cursor, +)`; `nothing`: the cursor is at the
 * latest position; `resync`: the buffer was trimmed past it, expired, or the cursor is older than the retention age.
 */
export function decideReplay(
  input: ReplayInput,
): 'replay' | 'nothing' | 'resync' {
  if (timeOf(input.cursor) < retentionCutoffMs(input.now, input.retentionMs))
    return 'resync';
  if (!input.exists) return 'resync';
  if (comparePositions(input.maxDeletedId, input.cursor) > 0) return 'resync';
  if (comparePositions(input.latestId, input.cursor) <= 0) return 'nothing';
  return 'replay';
}

/** Uniform integer in [min, max] from a random source in [0, 1). */
export const retryDelayMs = (random: number, min: number, max: number) =>
  min + Math.floor(random * (max - min + 1));

/**
 * Typed builder: `topicOf('shop:live', id)` is `shop:<id>:live`, `topicOf('user', id)` is `user:<id>`; an empty id builds
 * the bare singleton prefix. The route must be one some domain declared in `RealtimeTopicPrefixes`.
 */
export function topicOf<R extends keyof RealtimeTopicPrefixes & string>(
  route: R,
  id: string,
): RealtimeTopicPrefixes[R] {
  const [prefix, suffix] = route.split(':');
  const topic =
    id === ''
      ? prefix
      : suffix
        ? `${prefix}:${id}:${suffix}`
        : `${prefix}:${id}`;
  return topic as RealtimeTopicPrefixes[R];
}

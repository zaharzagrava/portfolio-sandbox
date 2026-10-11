import { notificationEventSchema, orderStatusEventSchema, paymentStatusEventSchema, type UserStreamEvent } from '@marketplace-sandbox/contracts';
import { openUserStreamSource } from '@/lib/api/user-stream-source';
import { sessionApi } from '@/lib/api/session';
import { endSession } from '@/lib/auth/session-ended';
import { FALLBACK_SILENCE_MS, nextPollDelay } from '@/lib/checkout/polling';

/**
 * The live stream of W03 (FR-050, AS-39, AS-45, AS-72): ONE `EventSource` per page, shared by every subscriber through a
 * reference count, on `GET /api/streams?topics=user:<id>` (S51). Module-level state is deliberate: it is a connection and a
 * small health record, read by `useSyncExternalStore`; there is no Context and no store. Nothing here touches TanStack Query:
 * subscribers decide what an event invalidates.
 */

export type UserHealth = 'connected' | 'reconnecting' | 'closed';
export type PollState = 'idle' | 'polling' | 'stopped';

export type UserEventHandler = {
  /** `order.status`, `payment.status` and `notification`, parsed with the contract schemas. Anything else is dropped. */
  onEvent?: (event: UserStreamEvent) => void;
  /** The server lost the replay window, or the stream reconnected: re-read what the page shows. */
  onResync?: () => void;
  /** The server revoked a topic. Nothing to show: the subscriber just stops expecting events. */
  onRevoked?: (topic: string) => void;
  /** Events of topics added with `addTopic(topic, eventTypes)`. */
  onTopicEvent?: (topic: string, type: string, data: unknown) => void;
};

export type UserStreamSnapshot = {
  /** `closed` until the first open and after a revocation or a failed session refresh; `reconnecting` after an error. */
  health: UserHealth;
  poll: PollState;
  /** The claimant (see `claimStreamBanner`) that renders the single banner of this page, if any. */
  bannerOwner: object | null;
  /** The stream is reconnecting: "Live updates paused. Reconnecting…" belongs on the page, rendered by `bannerOwner`. */
  showBanner: boolean;
};

const USER_EVENT_TYPES = ['order.status', 'payment.status', 'notification'] as const;
const NO_USER = '';

type Connection = { source: EventSource; generation: number };

const handlers = new Set<UserEventHandler>();
let userId = NO_USER;
const topicHolders = new Map<string, { count: number; types: Set<string> }>();
let connection: Connection | null = null;
let generation = 0;
let health: UserHealth = 'closed';
let everOpened = false;
let refreshTried = false;

const listeners = new Set<() => void>();
const bannerClaims: object[] = [];
let snapshot: UserStreamSnapshot = { health: 'closed', poll: 'idle', bannerOwner: null, showBanner: false };

// --- state store ------------------------------------------------------------------------------------------------------

let pollState: PollState = 'idle';

function publish(): void {
  const bannerOwner = bannerClaims[0] ?? null;
  const showBanner = health === 'reconnecting';
  if (snapshot.health === health && snapshot.poll === pollState && snapshot.bannerOwner === bannerOwner && snapshot.showBanner === showBanner) return;
  snapshot = { health, poll: pollState, bannerOwner, showBanner };
  for (const listener of [...listeners]) listener();
}

export function getUserStreamSnapshot(): UserStreamSnapshot {
  return snapshot;
}

export function subscribeUserStreamState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const SERVER_USER_STREAM_SNAPSHOT: UserStreamSnapshot = { health: 'closed', poll: 'idle', bannerOwner: null, showBanner: false };

function setHealth(next: UserHealth): void {
  health = next;
  publish();
}

/**
 * The banner is shown once per page: every component that could show it claims it, the first claimant owns it and the
 * others render nothing. The returned release function also carries the claim's `token`.
 */
export function claimStreamBanner(token: object = {}): (() => void) & { token: object } {
  bannerClaims.push(token);
  publish();
  const release = (() => {
    const at = bannerClaims.indexOf(token);
    if (at >= 0) bannerClaims.splice(at, 1);
    publish();
  }) as (() => void) & { token: object };
  release.token = token;
  return release;
}

// --- connection -------------------------------------------------------------------------------------------------------

const encodeTopic = (topic: string) => encodeURIComponent(topic).replace(/%3A/gi, ':');

function topics(): string[] {
  return [...(userId ? [`user:${userId}`] : []), ...topicHolders.keys()];
}

function closeConnection(): void {
  generation += 1;
  connection?.source.close();
  connection = null;
}

function parseFrame(event: Event): { topic: string; data: unknown } | null {
  try {
    const parsed = JSON.parse((event as MessageEvent).data as string) as { topic?: unknown; data?: unknown };
    return typeof parsed.topic === 'string' ? { topic: parsed.topic, data: parsed.data } : null;
  } catch {
    return null;
  }
}

function userEvent(type: (typeof USER_EVENT_TYPES)[number], data: unknown): UserStreamEvent | null {
  if (type === 'order.status') {
    const parsed = orderStatusEventSchema.safeParse(data);
    return parsed.success ? { type, data: parsed.data } : null;
  }
  if (type === 'payment.status') {
    const parsed = paymentStatusEventSchema.safeParse(data);
    return parsed.success ? { type, data: parsed.data } : null;
  }
  const parsed = notificationEventSchema.safeParse(data);
  return parsed.success ? { type, data: parsed.data } : null;
}

function each(call: (handler: UserEventHandler) => void): void {
  for (const handler of [...handlers]) {
    try {
      call(handler);
    } catch {
      /* one subscriber's failure must not stop the others */
    }
  }
}

function connect(): void {
  closeConnection();
  const list = topics();
  const source = handlers.size === 0 || list.length === 0 ? null : openUserStreamSource(list.map(encodeTopic));
  if (!source) {
    setHealth('closed');
    return;
  }
  const mine = generation;
  connection = { source, generation: mine };
  const live = () => connection?.generation === mine;

  source.addEventListener('open', () => {
    if (!live()) return;
    const reconnected = everOpened && health !== 'connected';
    everOpened = true;
    refreshTried = false;
    setHealth('connected');
    activity();
    if (reconnected) each((h) => h.onResync?.());
  });

  source.addEventListener('error', () => {
    if (!live()) return;
    if (source.readyState === 2 /* CLOSED: the browser gave up (401, 403, wrong content type) */) {
      void refuseAndRecover(mine);
      return;
    }
    setHealth('reconnecting');
  });

  for (const type of USER_EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      if (!live()) return;
      const frame = parseFrame(event);
      if (!frame) return;
      const parsed = userEvent(type, frame.data);
      if (!parsed) return;
      activity();
      each((h) => h.onEvent?.(parsed));
    });
  }

  source.addEventListener('resync', () => {
    if (!live()) return;
    activity();
    each((h) => h.onResync?.());
  });

  source.addEventListener('revoked', (event) => {
    if (!live()) return;
    const frame = parseFrame(event);
    const topic = frame?.topic ?? `user:${userId}`;
    each((h) => h.onRevoked?.(topic));
    if (topic === `user:${userId}`) userId = NO_USER;
    else topicHolders.delete(topic);
    connect();
  });

  const extra = new Set([...topicHolders.values()].flatMap((holder) => [...holder.types]));
  for (const type of extra) {
    source.addEventListener(type, (event) => {
      if (!live()) return;
      const frame = parseFrame(event);
      if (!frame) return;
      activity();
      each((h) => h.onTopicEvent?.(frame.topic, type, frame.data));
    });
  }
}

/** A refused connection (the browser will not retry): refresh the session once and recreate; otherwise W01's flow. */
async function refuseAndRecover(mine: number): Promise<void> {
  if (refreshTried) {
    closeConnection();
    setHealth('closed');
    endSession();
    return;
  }
  refreshTried = true;
  setHealth('reconnecting');
  let refreshed = false;
  try {
    const result = await sessionApi.refresh();
    refreshed = result.ok && result.kind === 'session';
  } catch {
    refreshed = false;
  }
  if (generation !== mine || handlers.size === 0) return;
  if (refreshed) {
    connect();
    return;
  }
  closeConnection();
  setHealth('closed');
  // A refused stream plus a refused refresh is only a hint that the session ended: the session read is the authority, so the
  // flow runs unless that read still answers with a member (then this page just goes without live updates).
  let stillMember = false;
  try {
    const current = await sessionApi.current();
    stillMember = current.ok && current.kind === 'session';
  } catch {
    stillMember = false;
  }
  if (!stillMember) endSession();
}

/**
 * Receive the page's live events. The first subscriber opens the connection, the last one closes it. `id` is the signed-in
 * user's id (the topic is `user:<id>`); a different id replaces the previous one.
 */
export function subscribeUserEvents(handler: UserEventHandler, id: string): () => void {
  const wasEmpty = handlers.size === 0;
  const idChanged = userId !== id;
  userId = id;
  handlers.add(handler);
  if (wasEmpty || idChanged || !connection) connect();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    handlers.delete(handler);
    if (handlers.size === 0) {
      closeConnection();
      userId = NO_USER;
      everOpened = false;
      refreshTried = false;
      setHealth('closed');
    }
  };
}

/** Add a topic to the shared connection (W04, W05). The connection is recreated once when the set changes. */
export function addTopic(topic: string, eventTypes: string[] = []): () => void {
  const holder = topicHolders.get(topic);
  const isNew = !holder;
  if (holder) {
    holder.count += 1;
    for (const type of eventTypes) holder.types.add(type);
  } else {
    topicHolders.set(topic, { count: 1, types: new Set(eventTypes) });
  }
  if (isNew && handlers.size > 0) connect();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = topicHolders.get(topic);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    topicHolders.delete(topic);
    if (handlers.size > 0) connect();
  };
}

// --- polling fallback (AS-39) -----------------------------------------------------------------------------------------

const pollers = new Set<() => void | Promise<void>>();
let silenceTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollStartedAt = 0;

function clearTimers(): void {
  clearTimeout(silenceTimer);
  clearTimeout(pollTimer);
  silenceTimer = undefined;
  pollTimer = undefined;
}

function runPollers(): void {
  for (const poll of [...pollers]) {
    try {
      void Promise.resolve(poll()).catch(() => undefined);
    } catch {
      /* a failed read is retried by the next scheduled poll */
    }
  }
}

function schedulePoll(): void {
  const delay = nextPollDelay(Date.now() - pollStartedAt);
  if (delay === null) {
    pollTimer = undefined;
    pollState = 'stopped';
    publish();
    return;
  }
  pollTimer = setTimeout(() => {
    runPollers();
    schedulePoll();
  }, delay);
}

function startPolling(): void {
  clearTimers();
  pollStartedAt = Date.now();
  pollState = 'polling';
  publish();
  schedulePoll();
}

function armSilence(): void {
  clearTimers();
  pollState = 'idle';
  publish();
  if (pollers.size > 0) silenceTimer = setTimeout(startPolling, FALLBACK_SILENCE_MS);
}

/** Any sign of life from the stream: polling stops and the 10 s of silence start over. */
function activity(): void {
  if (pollers.size > 0) armSilence();
}

/**
 * While `poll` is registered, the stream is watched: after 10 s without an event (or while it is down) `poll` runs on the
 * 2 s then 5 s schedule of `lib/checkout/polling.ts` (at most 30 a minute), until an event arrives, `stop()`, or the schedule
 * ends (`poll` state `stopped`: show the "taking longer" message and a Check again button, which calls `checkAgain()`).
 */
export function watchStreamSilence(poll: () => void | Promise<void>): { stop: () => void; checkAgain: () => void } {
  const entry = () => poll();
  const first = pollers.size === 0;
  pollers.add(entry);
  if (first) armSilence();
  return {
    stop: () => {
      if (!pollers.delete(entry)) return;
      if (pollers.size === 0) {
        clearTimers();
        pollState = 'idle';
        publish();
      }
    },
    checkAgain: () => {
      if (!pollers.has(entry)) return;
      runPollers();
      startPolling();
    },
  };
}

/** Test seam: forget every connection, handler, topic, claim and timer. */
export function resetUserStream(): void {
  closeConnection();
  clearTimers();
  handlers.clear();
  topicHolders.clear();
  pollers.clear();
  bannerClaims.length = 0;
  userId = NO_USER;
  everOpened = false;
  refreshTried = false;
  health = 'closed';
  pollState = 'idle';
  listeners.clear();
  publish();
}

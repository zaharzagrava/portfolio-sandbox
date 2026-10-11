import { CLIENT_EVENT_NAMES, type ClientEventInput } from '@marketplace-sandbox/contracts';
import { sendEvents } from '@/lib/api/events';

/**
 * Visitor events (W02 FR-140..FR-144, AS-67, AS-68, AS-77): validate, queue in module state, batch (20, every 5 s, on page
 * hide by beacon), retry a failed batch after 1, 2 and 4 seconds with the same `event_id`s, then drop. Browser only.
 * Global Privacy Control and Do Not Track create no cookie and no event. Search text, questions, discussion text and
 * coordinates are never put in an event. Nothing here is awaited by the caller.
 */

export type TrackEvent = {
  name: (typeof CLIENT_EVENT_NAMES)[number];
  /** Path without query or fragment (any query or fragment given is removed); default: the current path. */
  page?: string;
  props?: Record<string, string | number | boolean>;
};

const COOKIE = 'anonymous_id';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const BATCH_SIZE = 20;
const FLUSH_MS = 5000;
const RETRY_MS = [1000, 2000, 4000] as const;
const MAX_PROPS = 30;
const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_VALUE = 500;
const MAX_PAGE = 500;
/** Keys that would carry what a visitor typed or where they are (AS-77). */
const FORBIDDEN_KEYS = /^(q|query|search|search_text|searchtext|term|terms|question|text|message|body|comment|lat|lng|lon|latitude|longitude|coords|coordinates|location|position)$/i;

let queue: ClientEventInput[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimers = new Set<ReturnType<typeof setTimeout>>();
let listening = false;
let generation = 0;

const names = new Set<string>(CLIENT_EVENT_NAMES);

function privacySignal(): boolean {
  if (typeof navigator === 'undefined') return true;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  return nav.globalPrivacyControl === true || nav.doNotTrack === '1' || nav.msDoNotTrack === '1' || (typeof window !== 'undefined' && (window as unknown as { doNotTrack?: string }).doNotTrack === '1');
}

function cleanProps(props: TrackEvent['props']): ClientEventInput['props'] {
  if (!props || typeof props !== 'object') return undefined;
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    if (Object.keys(clean).length >= MAX_PROPS) break;
    if (!KEY_PATTERN.test(key) || FORBIDDEN_KEYS.test(key)) continue;
    if (typeof value === 'string') clean[key] = value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value;
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean') clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function cleanPage(page: string | undefined): string | undefined {
  const raw = typeof page === 'string' ? page : window.location.pathname;
  const path = raw.split('#')[0].split('?')[0];
  return path ? path.slice(0, MAX_PAGE) : undefined;
}

function readCookie(): string | undefined {
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return undefined;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return Array.from(bytes, (byte) => ID_ALPHABET[byte & 63]).join('');
}

/** The anonymous id: created on the first event, only when no privacy signal is set. */
function anonymousId(): string {
  const existing = readCookie();
  if (existing && ID_PATTERN.test(existing)) return existing;
  const id = newId();
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${id}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  return id;
}

async function deliver(batch: ClientEventInput[], beacon: boolean, attempt: number, epoch: number): Promise<void> {
  let result: Awaited<ReturnType<typeof sendEvents>>;
  try {
    result = await sendEvents(batch, { beacon });
  } catch {
    result = { ok: false, retryable: true };
  }
  if (epoch !== generation || result.ok || !result.retryable || attempt >= RETRY_MS.length) return;
  const timer = setTimeout(() => {
    retryTimers.delete(timer);
    if (epoch === generation) void deliver(batch, false, attempt + 1, epoch);
  }, RETRY_MS[attempt]);
  retryTimers.add(timer);
}

/** `fullOnly`: send only complete batches (the size trigger); the rest waits for the timer. */
function flush(beacon: boolean, fullOnly = false): void {
  if (!fullOnly && flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (queue.length === 0) return;
  if (privacySignal()) {
    queue = [];
    return;
  }
  while (fullOnly ? queue.length >= BATCH_SIZE : queue.length > 0) {
    const batch = queue.splice(0, BATCH_SIZE);
    void deliver(batch, beacon, 0, generation);
  }
  if (queue.length > 0) armTimer();
}

function armTimer(): void {
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    flush(false);
  }, FLUSH_MS);
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') flush(true);
}

function onPageHide(): void {
  flush(true);
}

function listen(): void {
  if (listening) return;
  listening = true;
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
}

export function track(event: TrackEvent): void {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (!event || !names.has(event.name) || privacySignal()) return;
    const props = cleanProps(event.props);
    const page = cleanPage(event.page);
    queue.push({
      event_id: crypto.randomUUID(),
      name: event.name,
      anonymous_id: anonymousId(),
      ts: Date.now(),
      ...(page ? { page } : {}),
      ...(props ? { props } : {}),
    });
    listen();
    if (queue.length >= BATCH_SIZE) {
      // Sent at once, but after the caller returns: tracking never blocks rendering or navigation.
      queueMicrotask(() => flush(false, true));
    }
    armTimer();
  } catch {
    // Analytics must never break the page.
  }
}

/** Forgets the queue, the timers and the listeners. For tests. */
export function __resetTrackForTests(): void {
  generation += 1;
  queue = [];
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  for (const timer of retryTimers) clearTimeout(timer);
  retryTimers = new Set();
  if (listening && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  }
  listening = false;
}

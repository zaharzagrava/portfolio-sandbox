/**
 * Pure rules of the chat composer (W05 FR-025, FR-028, AS-15, AS-18). The component only wires them to the DOM.
 */

/** 4,000 Unicode code points (S24 FR-010), not UTF-16 units. */
export const MESSAGE_LIMIT = 4000;
/** The counter appears beyond this many code points. */
export const COUNTER_FROM = 3500;

export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1; // eslint-disable-line @typescript-eslint/no-unused-vars
  return count;
}

/** Cuts at `limit` code points, never inside a surrogate pair (typing or pasting past the limit). */
export function cutToLimit(text: string, limit: number = MESSAGE_LIMIT): string {
  if (text.length <= limit) return text;
  const points = [...text];
  return points.length <= limit ? text : points.slice(0, limit).join('');
}

export const trimmedBody = (draft: string): string => draft.trim();

export function canSend(draft: string, state: { enabled: boolean; sending: boolean }): boolean {
  return state.enabled && !state.sending && trimmedBody(draft).length > 0;
}

type KeyLike = { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number };

/** Enter sends; Shift+Enter is a newline; Enter during IME composition (`isComposing`, or the legacy keyCode 229) never sends. */
export function shouldSendOnKey(event: KeyLike): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

/**
 * The counter "{n} / 4,000" appears beyond 3,500 code points. `announce` is true only when the count crosses 3,500 or 4,000
 * upward since `previous` (the live region speaks on crossings, not on every key).
 */
export function counterView(count: number, previous: number = count): { visible: boolean; text: string; announce: boolean } {
  const visible = count > COUNTER_FROM;
  const crossed = (threshold: number, inclusive: boolean) => (inclusive ? previous < threshold && count >= threshold : previous <= threshold && count > threshold);
  return {
    visible,
    text: visible ? `${count.toLocaleString('en-US')} / ${MESSAGE_LIMIT.toLocaleString('en-US')}` : '',
    announce: crossed(COUNTER_FROM, false) || crossed(MESSAGE_LIMIT, true),
  };
}

export type ComposerInput = {
  now: number;
  isArchived: boolean;
  banned: boolean;
  /** An ISO instant while the member is muted. */
  mutedUntil: string | null;
  /** The chat could not be loaded. */
  loadFailed: boolean;
};

export type ComposerState = { enabled: true; reason?: undefined; text?: undefined } | { enabled: false; reason: 'banned' | 'archived' | 'muted' | 'load-failed'; text: string };

const clockTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** The instant (epoch ms) a mute ends, or null when there is none, it is malformed, or it already ended. */
function activeMuteEnd(input: ComposerInput): number | null {
  if (!input.mutedUntil) return null;
  const end = Date.parse(input.mutedUntil);
  return Number.isFinite(end) && end > input.now ? end : null;
}

/** Why the composer is off, in the order banned, archived, muted, load failure; the reason is always visible text (FR-028). */
export function composerState(input: ComposerInput): ComposerState {
  if (input.banned) return { enabled: false, reason: 'banned', text: 'You can no longer take part in this chat.' };
  if (input.isArchived) return { enabled: false, reason: 'archived', text: 'This chat was archived. You can read it, but not reply.' };
  if (activeMuteEnd(input) !== null) return { enabled: false, reason: 'muted', text: `You're muted until ${clockTime(input.mutedUntil!)}.` };
  if (input.loadFailed) return { enabled: false, reason: 'load-failed', text: "We couldn't load this chat." };
  return { enabled: true };
}

/** Milliseconds until a mute ends (the timer that re-enables the composer), or null when no mute is running. */
export function msUntilReEnabled(input: ComposerInput): number | null {
  const end = activeMuteEnd(input);
  return end === null ? null : end - input.now;
}

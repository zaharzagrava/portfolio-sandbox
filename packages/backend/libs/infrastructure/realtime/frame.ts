/**
 * The single SSE serializer (S51 FR-004). Pure. A payload cannot inject fields or frames: the JSON text has every line
 * terminator escaped (`JSON.stringify` escapes LF and CR; the Unicode line and paragraph separators are escaped here
 * too), and the event type is validated instead of written raw.
 */
export const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;
/** Names the hub writes itself, or that collide with built-in browser event names. */
export const RESERVED_EVENT_TYPES: readonly string[] = [
  'open',
  'error',
  'resync',
  'revoked',
];

export const HEARTBEAT_FRAME = ': ping\n\n';

const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

const json = (value: unknown): string =>
  JSON.stringify(value)
    .replace(LINE_SEPARATOR, '\\u2028')
    .replace(PARAGRAPH_SEPARATOR, '\\u2029');

export interface FrameInput {
  /** Connection cursor for the `id:` line; absent for live-only events. */
  cursor?: string;
  type: string;
  topic: string;
  data: unknown;
}

/** `null` when the type is not writable (never published through the validated publisher; skipped and counted). */
export function formatFrame(input: FrameInput): string | null {
  if (!EVENT_TYPE.test(input.type) || RESERVED_EVENT_TYPES.includes(input.type))
    return null;
  return (
    (input.cursor ? `id: ${input.cursor}\n` : '') +
    `event: ${input.type}\ndata: ${json({ topic: input.topic, data: input.data })}\n\n`
  );
}

export const formatRetry = (ms: number) => `retry: ${Math.trunc(ms)}\n\n`;
export const formatBaseline = (cursor: string) => `id: ${cursor}\n\n`;
export const formatResync = (topic: string) =>
  `event: resync\ndata: ${json({ topic, data: { reason: 'replay-gap' } })}\n\n`;
export const formatRevoked = (topic: string) =>
  `event: revoked\ndata: ${json({ topic, data: {} })}\n\n`;

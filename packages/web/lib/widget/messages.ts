/**
 * The iframe half of the storefront widget's `postMessage` contract (S44 loader, W07 AS-40). Pure: no DOM globals are
 * read here, so the same rules run in the bundle and in the tests.
 *
 * - to the host page: only `marketplace:need-identity` and `marketplace:close`, only to the parent window, only with the
 *   host's own origin as `targetOrigin` (never `"*"`);
 * - from the host page: only `marketplace:identity { token }`, only when `event.source` is the parent window and
 *   `event.origin` is the host origin; everything else is ignored without a trace.
 */
export const MESSAGE_TYPES = {
  needIdentity: 'marketplace:need-identity',
  identity: 'marketplace:identity',
  close: 'marketplace:close',
} as const;

const MAX_TOKEN_LENGTH = 4096;

export type OutgoingMessage = { type: typeof MESSAGE_TYPES.needIdentity } | { type: typeof MESSAGE_TYPES.close };
export type IdentityContext = { parent: unknown; hostOrigin: string | null };
export type IncomingEvent = { source: unknown; origin: string; data: unknown };

/** Whether `value` is exactly an `http(s)://host[:port]` origin (never `"*"`, `"null"`, a path or another scheme). */
export const isWebOrigin = (value: string | null | undefined): value is string => asWebOrigin(value) !== null;

/** `https://host[:port]` exactly: what `URL.origin` gives for a web address. */
function asWebOrigin(value: string | null | undefined): string | null {
  if (!value || value === 'null' || value === '*') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

/** The host page's origin as the browser reports it: ancestor origins where available, else the referrer's origin. */
export function hostOriginOf(input: { ancestorOrigins?: ArrayLike<string> | undefined; referrer: string }): string | null {
  const ancestor = input.ancestorOrigins?.[0];
  if (ancestor !== undefined) return asWebOrigin(ancestor);
  if (!input.referrer) return null;
  try {
    const url = new URL(input.referrer);
    return asWebOrigin(url.origin);
  } catch {
    return null;
  }
}

/** Posts to the host page. Returns `false` (and posts nothing) when the host origin is unknown or not a plain web origin. */
export function postToHost(parent: Window, hostOrigin: string | null, message: OutgoingMessage): boolean {
  const target = asWebOrigin(hostOrigin);
  if (!target) return false;
  try {
    parent.postMessage(message, target);
    return true;
  } catch {
    return false;
  }
}

/** The token of a valid identity message, `{ token: null }` when the host has none; `null` for anything not to be trusted. */
export function acceptIdentityMessage(event: IncomingEvent, context: IdentityContext): { token: string | null } | null {
  const host = asWebOrigin(context.hostOrigin);
  if (!host || event.origin !== host) return null;
  if (!context.parent || event.source !== context.parent) return null;
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('token')) return null;
  const { type, token } = data as { type: unknown; token: unknown };
  if (type !== MESSAGE_TYPES.identity) return null;
  if (token === null) return { token: null };
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  return { token };
}

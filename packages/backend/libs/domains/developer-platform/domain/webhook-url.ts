import { isIP } from 'node:net';
import type { EndpointUrlRejectionReason } from '@marketplace-sandbox/contracts';

/** Syntactic rules for a webhook endpoint address (S43 FR-002, FR-003, FR-005). Pure: no lookup, no clock, no framework. */
export const WEBHOOK_URL_MAX_LENGTH = 2048;

export type EndpointUrlFailure =
  /** Not a string, not parseable, or with surrounding whitespace: `400 validation_failed` on `url`. */
  | { kind: 'malformed' }
  /** Over 2,048 characters: `400 validation_failed` on `url`. */
  | { kind: 'too_long' }
  /** A rule of the guard: `422 endpoint_url_rejected` with `details.reason`. */
  | { kind: 'rejected'; reason: EndpointUrlRejectionReason };

export type ParsedEndpointUrl =
  | {
      ok: true;
      /** Lower-case host, no default port, no fragment: the value the unique index is built on. */
      normalized: string;
      /** Host name only; the one part of an address that may reach events, logs and metrics (AS-58). */
      host: string;
    }
  | { ok: false; failure: EndpointUrlFailure };

const reject = (reason: EndpointUrlRejectionReason): ParsedEndpointUrl => ({
  ok: false,
  failure: { kind: 'rejected', reason },
});

/**
 * Checks, in this order: string, length, parse, `https`, no user-info, port 443, no IP literal (any spelling the URL
 * parser turns into an address, so `2130706433` and `0x7f000001` are literals too), not `localhost` or a name under it.
 * Whether the name resolves to public addresses is the guard's job at save time and on every attempt, not this file's.
 */
export function parseEndpointUrl(
  raw: string,
  /** `host:port` of local receivers (local profile): those, and only those, may use a port and an IP literal. */
  allowedReceiverHosts: readonly string[] = [],
): ParsedEndpointUrl {
  if (typeof raw !== 'string' || raw.length === 0 || raw !== raw.trim())
    return { ok: false, failure: { kind: 'malformed' } };
  if (raw.length > WEBHOOK_URL_MAX_LENGTH)
    return { ok: false, failure: { kind: 'too_long' } };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, failure: { kind: 'malformed' } };
  }
  if (url.protocol !== 'https:') return reject('not_https');
  if (url.username || url.password) return reject('credentials_not_allowed');
  if (url.port !== '' && allowedReceiverHosts.includes(url.host))
    return {
      ok: true,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      normalized: `https://${url.host}${url.pathname}${url.search}`,
    };
  if (url.port !== '') return reject('port_not_allowed'); // `:443` is the default and parses to ''
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 0) return reject('ip_literal');
  const host = bare.replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost'))
    return reject('blocked_address');
  if (host === '') return { ok: false, failure: { kind: 'malformed' } };
  return {
    ok: true,
    host,
    normalized: `https://${url.hostname}${url.pathname}${url.search}`,
  };
}

/** The unique-index form of an address, or null when it does not parse at all (policy rules are not applied here). */
export function normalizeEndpointUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return `https://${url.hostname}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

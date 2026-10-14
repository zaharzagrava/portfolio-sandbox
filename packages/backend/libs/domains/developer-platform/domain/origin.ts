import { domainToASCII } from 'node:url';
import type { OriginRejection } from '@marketplace-sandbox/contracts';

export type { OriginRejection };

export type NormalizedOrigin =
  { ok: true; origin: string } | { ok: false; reason: OriginRejection };

const MAX_LENGTH = 253;
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const reject = (reason: OriginRejection): NormalizedOrigin => ({
  ok: false,
  reason,
});

/**
 * The one origin rule (FR-003, AS-02): a bare `https` origin, lower-cased, host in ASCII, default port removed. Anything
 * that is not exactly an origin (path, query, fragment, user info) is refused rather than trimmed. Pure.
 */
export function normalizeOrigin(input: unknown): NormalizedOrigin {
  if (typeof input !== 'string' || input === '') return reject('malformed');
  if (input.length > MAX_LENGTH) return reject('malformed');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what an origin must not contain
  if (/[\s\u0000-\u001f\u007f]/.test(input)) return reject('malformed');

  const scheme = SCHEME.exec(input);
  if (!scheme) return reject('malformed');
  const protocol = scheme[1].toLowerCase();
  if (protocol === 'http') return reject('not_https');
  if (protocol !== 'https') return reject('malformed');

  const rest = input.slice(scheme[0].length);
  if (/[/?#\\]/.test(rest)) return reject('not_an_origin');
  if (rest.includes('@')) return reject('userinfo');

  let host = rest;
  let portText: string | null = null;
  if (rest.startsWith('[')) return reject('ip_literal');
  const colon = rest.lastIndexOf(':');
  if (colon !== -1) {
    host = rest.slice(0, colon);
    portText = rest.slice(colon + 1);
  }
  if (host === '') return reject('malformed');
  if (host.includes('*')) return reject('wildcard');
  if (host.endsWith('.')) return reject('trailing_dot');
  host = host.toLowerCase();
  if (IPV4.test(host)) return reject('ip_literal');
  if (host === 'localhost' || host.endsWith('.localhost'))
    return reject('localhost');

  const ascii = domainToASCII(host);
  if (ascii === '') return reject('malformed');
  const labels = ascii.split('.');
  if (labels.length < 2) return reject('single_label_host');
  if (!labels.every((l) => LABEL.test(l))) return reject('malformed');
  if (/^\d+$/.test(labels[labels.length - 1])) return reject('malformed');

  let port = '';
  if (portText !== null) {
    if (!/^\d{1,5}$/.test(portText)) return reject('malformed');
    const n = Number(portText);
    if (n < 1 || n > 65535) return reject('bad_port');
    if (n !== 443) port = `:${n}`;
  }
  return { ok: true, origin: `https://${ascii}${port}` };
}

export type NormalizedOrigins =
  | { ok: true; origins: string[] }
  | { ok: false; origin: unknown; reason: OriginRejection };

/** A list of origins, each normalised, duplicates collapsed (first position kept); the first rejection is reported. */
export function normalizeOrigins(list: readonly unknown[]): NormalizedOrigins {
  const seen = new Set<string>();
  for (const item of list) {
    const result = normalizeOrigin(item);
    if (!result.ok) return { ok: false, origin: item, reason: result.reason };
    seen.add(result.origin);
  }
  return { ok: true, origins: [...seen] };
}

/**
 * Whole-origin equality after normalisation (FR-011, AS-15): never a prefix, suffix or substring test. `registered` holds
 * normalised origins; a candidate that is not exactly an origin (path, list, `null`) never matches.
 */
export function matchOrigin(
  registered: readonly string[],
  candidate: unknown,
): boolean {
  const result = normalizeOrigin(candidate);
  return result.ok && registered.includes(result.origin);
}

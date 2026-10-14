import { normalizeOrigin } from './origin';

/** Every response of the application but the embed document (FR-024, AS-36). */
export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";

const NONCE = /^[A-Za-z0-9+/_-]{22,}={0,2}$/;

/**
 * The value of `frame-ancestors` for a site (FR-024, AS-35, AS-38): its registered origins, sorted, once each, separated
 * by one space. Registration already refuses anything that is not a normalised origin; the builder refuses it too, because
 * a value with whitespace, `;`, `,` or a quote would end the directive and write another one into a header.
 */
export function buildFrameAncestors(origins: readonly string[]): string {
  if (origins.length === 0)
    throw new Error('frame-ancestors needs at least one origin');
  const unique = new Set<string>();
  for (const origin of origins) {
    const normalised = normalizeOrigin(origin);
    if (!normalised.ok || normalised.origin !== origin)
      throw new Error('frame-ancestors accepts only normalised origins');
    unique.add(origin);
  }
  return [...unique].sort().join(' ');
}

/** The Content-Security-Policy of the embed document (FR-025, AS-34). The nonce is at least 128 bits, base64. */
export function buildEmbedCsp(input: {
  nonce: string;
  origins: readonly string[];
}): string {
  if (!NONCE.test(input.nonce)) throw new Error('invalid CSP nonce');
  return [
    "default-src 'none'",
    `script-src 'nonce-${input.nonce}' 'strict-dynamic'`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${buildFrameAncestors(input.origins)}`,
  ].join('; ');
}

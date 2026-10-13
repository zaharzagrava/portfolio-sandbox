import type { Clock } from '@app/common/core/clock';

/** CloudFront signed-cookie names -> values; set verbatim as cookies. */
export type SignedCookies = Record<
  'CloudFront-Policy' | 'CloudFront-Signature' | 'CloudFront-Key-Pair-Id',
  string
>;

export interface SignCookiesInput {
  /** One absolute `https://host/<prefix>/<id>/*` pattern: the credential covers nothing else. */
  resourcePattern: string;
  expiresAt: Date;
}

/** Life of a playback credential (S30 FR-041). */
export const CREDENTIAL_TTL_MS = 4 * 3600 * 1000;

/** Expiry of a credential issued now; time always comes from the injected clock. */
export const credentialExpiresAt = (clock: Clock): Date =>
  new Date(clock.nowMs() + CREDENTIAL_TTL_MS);

/** Signing or invalidation was asked for but the edge has no key pair / invalidation path configured. Never degrade to an unsigned URL. */
export class DeliveryEdgeNotConfiguredError extends Error {
  constructor(what = 'signing key pair') {
    super(`delivery edge is not configured: ${what}`);
    this.name = 'DeliveryEdgeNotConfiguredError';
  }
}

/**
 * The CDN in front of the video bucket: issues signed credentials for unlisted playback and removes cached paths.
 * Implementations: CloudFront, in-memory (tests), unconfigured (throws).
 */
export abstract class DeliveryEdge {
  /** Signed cookies for one path pattern with one expiry. Throws `DeliveryEdgeNotConfiguredError` without a key. */
  abstract signCookies(input: SignCookiesInput): Promise<SignedCookies>;

  /** Asks the edge to drop cached copies of the paths (for example `/p/<id>/*`). */
  abstract invalidate(paths: string[]): Promise<void>;
}

/** The pattern must be an absolute URL whose path is a prefix directory plus one trailing `*` (a single video). */
export function assertSingleVideoPattern(resourcePattern: string): void {
  let url: URL;
  try {
    url = new URL(resourcePattern.replace(/\*$/, 'x'));
  } catch {
    throw new Error('resourcePattern must be an absolute URL');
  }
  const path = url.pathname.slice(0, -1);
  if (
    !/^https?:$/.test(url.protocol) ||
    !resourcePattern.endsWith('/*') ||
    url.search ||
    url.hash ||
    path.includes('*') ||
    path.split('/').filter(Boolean).length < 2
  )
    throw new Error(
      'resourcePattern must be https://host/<prefix>/<id>/* (one video)',
    );
}

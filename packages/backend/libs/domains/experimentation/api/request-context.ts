import { createHash, timingSafeEqual } from 'node:crypto';
import { FLAG_PLATFORMS } from '@marketplace-sandbox/contracts';
import type { RequestFacts } from '../application/eval-context.service';

const ANONYMOUS_ID = /^[A-Za-z0-9_-]{8,64}$/;
const COUNTRY = /^[A-Za-z]{2}$/;

interface RequestLike {
  user?: { id?: string; email?: string; role?: string };
  /** Set by tenancy's `ShopGuard` after the membership check; never by the client. */
  shopId?: string;
  headers: Record<string, string | string[] | undefined>;
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Constant-time comparison of two secrets of any length (digests have equal length). */
const sameSecret = (given: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(given).digest(),
    createHash('sha256').update(expected).digest(),
  );

/**
 * What a request may say about its caller (FR-041 – FR-044, R-14): user, role and e-mail domain only from the
 * authenticated principal, never from a header; the shop is only a candidate (the membership check decides); the anonymous
 * id only when it has the allowed shape; the platform only from the closed set; the country only when the edge presented
 * its credential. Pure, so the table of what is ignored is unit-testable.
 */
export function factsFromRequest(
  req: RequestLike,
  edgeSecret: string | undefined,
): RequestFacts {
  const h = (name: string) => first(req.headers[name]);
  const anonymousId = h('x-anonymous-id');
  const platform = h('x-client-platform');
  const country = h('cf-ipcountry');
  const credential = h('x-edge-credential');
  const trustedEdge =
    !!edgeSecret && !!credential && sameSecret(credential, edgeSecret);
  const email = req.user?.email;
  return {
    userId: req.user?.id,
    role: req.user?.role,
    emailDomain: email?.includes('@') ? email.split('@')[1] : undefined,
    verifiedShopId: req.shopId,
    shopHeader: h('x-shop-id'),
    anonymousId:
      anonymousId && ANONYMOUS_ID.test(anonymousId) ? anonymousId : undefined,
    platform:
      platform && (FLAG_PLATFORMS as readonly string[]).includes(platform)
        ? platform
        : undefined,
    country:
      trustedEdge && country && COUNTRY.test(country)
        ? country.toUpperCase()
        : undefined,
  };
}

import { createHash } from 'node:crypto';
import type { RateLimitKeySource } from './rate-limit.types';

/** What the subject code needs from a request; the address is the platform's trusted-proxy result, never a header (FR-036). */
export interface SubjectRequest {
  clientIp?: string;
  user?: { id: string };
  apiKey?: { id: string; shopId?: string };
  shopId?: string;
  body?: unknown;
  headers?: unknown;
}

const sha32 = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);

const MAX_CUSTOM_LENGTH = 128;

export const EMPTY_EMAIL_SUBJECT = `email:${sha32('')}`;

export const ipSubject = (address: string | undefined): string =>
  `ip:${address || 'unknown'}`;

/** SHA-256 of the trimmed, lower-cased value, 32 hex characters; anything that is not a usable string is the one "empty" subject. */
export function emailSubject(value: unknown): string {
  if (typeof value !== 'string') return EMPTY_EMAIL_SUBJECT;
  const normalized = value.trim().toLowerCase();
  return normalized ? `email:${sha32(normalized)}` : EMPTY_EMAIL_SUBJECT;
}

/** Up to 128 characters as given; longer, or containing hash-tag braces, replaced by its hash (FR-039, FR-013). */
export function customSubject(value: string): string {
  return value.length > MAX_CUSTOM_LENGTH || /[{}]/.test(value)
    ? `custom:${sha32(value)}`
    : `custom:${value}`;
}

export interface ResolvedSubject {
  subject: string;
  /** The identity the policy asked for was missing and the address was used instead (FR-037). */
  fellBack: boolean;
}

export function resolveSubject(
  source: RateLimitKeySource,
  req: SubjectRequest,
  custom?: (req: SubjectRequest) => string | null | undefined,
): ResolvedSubject {
  const address = ipSubject(req.clientIp);
  const fallback: ResolvedSubject = { subject: address, fellBack: true };
  switch (source) {
    case 'ip':
      return { subject: address, fellBack: false };
    case 'userOrIp':
      return req.user?.id
        ? { subject: `user:${req.user.id}`, fellBack: false }
        : { subject: address, fellBack: false };
    case 'user':
      return req.user?.id
        ? { subject: `user:${req.user.id}`, fellBack: false }
        : fallback;
    case 'apiKey':
      return req.apiKey?.id
        ? { subject: `key:${req.apiKey.id}`, fellBack: false }
        : fallback;
    case 'shop': {
      const shopId = req.apiKey?.shopId ?? req.shopId;
      return shopId ? { subject: `shop:${shopId}`, fellBack: false } : fallback;
    }
    case 'body.email': {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return { subject: emailSubject(email), fellBack: false };
    }
    case 'custom': {
      const value = custom?.(req);
      return typeof value === 'string' && value !== ''
        ? { subject: customSubject(value), fellBack: false }
        : fallback;
    }
  }
}

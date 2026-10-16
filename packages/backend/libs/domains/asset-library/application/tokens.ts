import { createHash, randomBytes } from 'node:crypto';

/** 192 random bits as base64url (32 characters): share tokens and download grants (FR-032, FR-036). */
export const newToken = (): string => randomBytes(24).toString('base64url');

/** What is stored: the SHA-256 digest, hex. The token itself is never stored or logged. */
export const digestOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** A token shape that can possibly be ours; anything else is unknown without a lookup. */
export const looksLikeToken = (token: string): boolean =>
  /^[A-Za-z0-9_-]{32}$/.test(token);

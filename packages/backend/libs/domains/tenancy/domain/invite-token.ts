import { createHash, randomBytes } from 'node:crypto';

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

/** 192 bits, url-safe. It leaves the system only in the single-consumer `tenancy.invite_requested` message. */
export const generateInviteToken = (): string =>
  randomBytes(24).toString('base64url');

/** What is stored: the token itself is never persisted or logged. */
export const digestInviteToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

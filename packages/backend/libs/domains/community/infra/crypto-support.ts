import { createHmac, randomBytes } from 'node:crypto';
import { createCursorCodec, type CursorCodec } from '../domain/cursor';
import type { RandomBytes } from '../domain/ports';

/** Random bytes for time-based ids (the domain never touches `node:crypto`). */
export const cryptoRandomBytes: RandomBytes = {
  bytes: (length) => new Uint8Array(randomBytes(length)),
};

/** Opaque, tamper-evident cursors signed with the configured secret (HMAC-SHA256, first 16 bytes, base64url). */
export const hmacCursorCodec = (secret: string): CursorCodec =>
  createCursorCodec((data) =>
    createHmac('sha256', secret).update(data).digest('base64url').slice(0, 22),
  );

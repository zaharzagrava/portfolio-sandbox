import { createHmac } from 'node:crypto';

const NAMESPACE = 'launch-events/live/author-handle/v1';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * The name a viewer shows in one stream (FR-025): a keyed hash of (stream, user) mapped to eight letters, so it is
 * stable inside the stream, different in every other stream, cannot be turned back into the input, and echoes nothing
 * of it (letters only: no digit of the id and no part of an e-mail can appear).
 */
export function authorHandle(userId: string, streamId: string): string {
  const digest = createHmac('sha256', NAMESPACE)
    .update(`${streamId}:${userId}`)
    .digest();
  let handle = 'viewer-';
  for (let i = 0; i < 8; i++) handle += LETTERS[digest[i] % LETTERS.length];
  return handle;
}

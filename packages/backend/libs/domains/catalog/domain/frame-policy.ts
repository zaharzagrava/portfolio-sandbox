import * as decoding from 'lib0/decoding';
import { DRAFT_LIMITS } from './draft-limits';

/** What a member may do in a room: `write` holds `products.write` on a `DRAFT`, `read` does not. */
export type Ability = 'read' | 'write';

export type FrameKind =
  'sync-step1' | 'sync-step2' | 'sync-update' | 'awareness' | 'query-awareness';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

/** Reads the y-websocket message type of a frame; anything that does not decode, or a type a client may not send, is `malformed` (close 4000). */
export function classifyFrame(bytes: Uint8Array): FrameKind | 'malformed' {
  try {
    const dec = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(dec);
    if (type === MESSAGE_AWARENESS) return 'awareness';
    if (type === MESSAGE_QUERY_AWARENESS) return 'query-awareness';
    if (type !== MESSAGE_SYNC) return 'malformed';
    switch (decoding.readVarUint(dec)) {
      case 0:
        return 'sync-step1';
      case 1:
        return 'sync-step2';
      case 2:
        return 'sync-update';
      default:
        return 'malformed';
    }
  } catch {
    return 'malformed';
  }
}

/**
 * A state frame that carries nothing: a client with no edits answers the server's sync step 1 with an empty step 2
 * (`[0, 1, 2, 0, 0]`). That is part of the handshake, not a write, so even a read-only member may send it.
 */
export function isEmptyStateFrame(bytes: Uint8Array): boolean {
  try {
    const dec = decoding.createDecoder(bytes);
    if (decoding.readVarUint(dec) !== MESSAGE_SYNC) return false;
    const type = decoding.readVarUint(dec);
    if (type !== 1 && type !== 2) return false;
    const update = decoding.readVarUint8Array(dec);
    return update.byteLength === 2 && update[0] === 0 && update[1] === 0;
  } catch {
    return false;
  }
}

/** A read-only member may ask for state and send presence; it may not send state (step 2 or update). */
export function abilityAllows(ability: Ability, kind: FrameKind): boolean {
  if (ability === 'write') return true;
  return kind !== 'sync-step2' && kind !== 'sync-update';
}

/** `too_large` closes the connection with 1009: a frame over 512 KiB, a presence frame over 8 KiB. */
export function checkFrameSize(
  kind: FrameKind,
  size: number,
): 'ok' | 'too_large' {
  if (size > DRAFT_LIMITS.frameBytes) return 'too_large';
  if (kind === 'awareness' && size > DRAFT_LIMITS.presenceBytes)
    return 'too_large';
  return 'ok';
}

/** Per connection frame counter in fixed one second windows; `hit` is true when the window holds more than 200 frames (close 4029). */
export class FrameRate {
  private windowStart = Number.NEGATIVE_INFINITY;
  private count = 0;

  hit(nowMs: number): boolean {
    if (nowMs - this.windowStart >= 1000) {
      this.windowStart = nowMs;
      this.count = 0;
    }
    this.count += 1;
    return this.count > DRAFT_LIMITS.framesPerSecond;
  }
}

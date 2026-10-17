import { createHmac, timingSafeEqual } from 'node:crypto';

/** Allowed difference between the signer's and the verifier's clock. */
export const INTERNAL_SKEW_MS = 30_000;

export interface InternalCall {
  /** `freeze`, `unfreeze` or `flush`. */
  action: string;
  draftId: string;
  leaseId: string;
  timestamp: number;
}

const message = (call: InternalCall) =>
  `${call.timestamp}.${call.action}.${call.draftId}.${call.leaseId}`;

/** HMAC-SHA256 (hex) of the call, keyed with the collab ticket key: instance-to-instance calls only (S06 collab-ws.md). */
export function signInternal(key: string, call: InternalCall): string {
  return createHmac('sha256', key).update(message(call)).digest('hex');
}

/** Constant-time check of the signature and the timestamp window. */
export function verifyInternal(
  key: string,
  call: InternalCall,
  signature: string,
  nowMs: number,
): boolean {
  if (!Number.isFinite(call.timestamp)) return false;
  if (Math.abs(nowMs - call.timestamp) > INTERNAL_SKEW_MS) return false;
  const expected = Buffer.from(signInternal(key, call), 'hex');
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

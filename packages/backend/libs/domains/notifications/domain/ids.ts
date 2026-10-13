import { createHash } from 'node:crypto';

/**
 * Deterministic identifiers of a notification (FR-002, research R-6): the same dedupe identity always yields the same
 * delivery id and inbox item id, so replaying an event re-does the same work against the same rows.
 */

const sha256 = (value: string): Buffer =>
  createHash('sha256').update(value).digest();

const hex = (value: number | Buffer, digits = 0): string =>
  typeof value === 'number'
    ? value.toString(16).padStart(digits, '0')
    : value.toString('hex');

/** UUID-shaped id (version 5 layout) derived from `seed`. */
function uuidFrom(seed: string): string {
  const h = sha256(seed);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = hex(h.subarray(0, 16));
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** A recipient that routing can address: a user, or a bare address (invitations). */
export type IdentityRecipient =
  { kind: 'user'; userId: string } | { kind: 'address'; email: string };

export const recipientKeyOf = (recipient: IdentityRecipient): string =>
  recipient.kind === 'user'
    ? recipient.userId
    : `address:${recipient.email.trim().toLowerCase()}`;

/** Dedupe identity of a notification before the channel: source event id (or the owner's key) and recipient (FR-002). */
export const identityOf = (
  sourceId: string,
  recipient: IdentityRecipient,
): string => `${sourceId}|${recipientKeyOf(recipient)}`;

/** `identity` = `<sourceId>|<recipientKey>`; one delivery per channel. */
export const deliveryIdFor = (identity: string, channel: string): string =>
  uuidFrom(`delivery|${identity}|${channel}`);

/** 100-ns intervals between 1582-10-15 (the UUID epoch) and 1970-01-01, in milliseconds. */
const UUID_EPOCH_OFFSET_MS = 12_219_292_800_000n;

/**
 * Time-UUID (version 1 layout) whose time is `at` and whose other bits come from `identity`: it sorts by event time in
 * the inbox partition and is the same for a replay. The sub-millisecond ticks and the node come from the hash.
 */
export function inboxItemIdFor(identity: string, at: Date): string {
  const h = sha256(`inbox|${identity}`);
  const ticks = BigInt(h.readUInt16BE(0) % 10_000);
  const t = (BigInt(at.getTime()) + UUID_EPOCH_OFFSET_MS) * 10_000n + ticks;
  const timeLow = Number(t & 0xffff_ffffn);
  const timeMid = Number((t >> 32n) & 0xffffn);
  const timeHigh = Number((t >> 48n) & 0x0fffn) | 0x1000;
  const clockSeq = (h.readUInt16BE(2) & 0x3fff) | 0x8000;
  const node = Buffer.from(h.subarray(4, 10));
  node[0] |= 0x01;
  return `${hex(timeLow, 8)}-${hex(timeMid, 4)}-${hex(timeHigh, 4)}-${hex(clockSeq, 4)}-${hex(node)}`;
}

import { createHash } from 'node:crypto';
import { HOT_ACCOUNTS } from './account';

/** Stable hash of the shard key: `readUInt32BE(sha256(key)[0..4]) mod N` (research R-5). */
export function shardOf(key: string, shards: number): number {
  if (shards <= 1) return 0;
  const digest = createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % shards;
}

/** The three hot accounts of one journal use the same shard index; every other account is shard 0. */
export function shardFor(
  accountId: string,
  shardKey: string,
  shards: number,
): number {
  return HOT_ACCOUNTS.includes(accountId) ? shardOf(shardKey, shards) : 0;
}

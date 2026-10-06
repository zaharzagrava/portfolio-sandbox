/** Redis keys + channels for SD-15. Per-stream keys are hash-tagged so stream-level multi-key ops stay on one shard. */
export const ACTIVE_STREAMS = 'live:active';
export const recentKey = (id: string) => `live:{${id}}:recent`;
export const pinKey = (id: string) => `live:{${id}}:pin`;
export const bannedKey = (id: string) => `live:{${id}}:banned`;
export const viewersKey = (id: string) => `live:{${id}}:viewers`;
export const tickerLeaseKey = (id: string) => `live:{${id}}:ticker`;
/**
 * Reactions: one hash per (stream, second, shard). NOT hash-tagged on purpose:
 * 200k HINCRBY/s on one stream must spread across cluster shards.
 */
export const REACTION_SHARDS = 8;
export const reactionKey = (id: string, second: number, shard: number) => `live:rx:${id}:${second}:${shard}`;
/** Raw comment firehose for gateways' batchers; not a public realtime topic (clients can't subscribe to it). */
export const firehoseTopic = (id: string) => `livefeed:${id}`;

export const RECENT_COMMENTS = 50;
export const ALLOWED_REACTIONS = ['❤️', '🔥', '😂', '😮', '👏', '🛒'] as const;
export type Reaction = (typeof ALLOWED_REACTIONS)[number];

export interface LiveComment {
  id: string;
  streamId: string;
  authorId: string;
  authorName: string;
  text: string;
  at: number;
  /** Always delivered (shop staff answers, pinned shop messages), never sampled away. */
  priority?: boolean;
}

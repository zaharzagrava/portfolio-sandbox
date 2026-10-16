import type { LiveComment, Reaction } from './live-constants';

export type { LiveComment, Reaction };

/**
 * Redis keys and topics of the live stream. Per-stream keys are hash-tagged (`{id}`) so multi-key operations on one
 * stream stay on one shard. Everything here is derived or short-lived: the stream record is the authority (FR-041).
 */
export const ACTIVE_STREAMS = 'live:active';
export const recentKey = (id: string) => `live:{${id}}:recent`;
export const bannedKey = (id: string) => `live:{${id}}:banned`;
export const bannedFilledKey = (id: string) => `live:{${id}}:banned-ok`;
export const viewersKey = (id: string) => `live:{${id}}:viewers`;
export const tickerLeaseKey = (id: string) => `live:{${id}}:ticker`;
export const clientIdKey = (id: string, userId: string, clientId: string) =>
  `live:{${id}}:cid:${userId}:${clientId}`;
export const removalClaimKey = (id: string, commentId: string) =>
  `live:{${id}}:rm:${commentId}`;
export const statsMarkerKey = (id: string, second: number) =>
  `live:{${id}}:pub:${second}`;
export const aggregationMarkerKey = (id: string, second: number) =>
  `live:{${id}}:agg:${second}`;
/** Reactions: one hash per (stream, second, shard); deliberately NOT hash-tagged so the load spreads. */
export const reactionKey = (id: string, second: number, shard: number) =>
  `live:rx:${id}:${second}:${shard}`;
/** Raw comment feed for the gateways' batchers; not a public realtime topic (no route, no client can subscribe). */
export const firehoseTopic = (id: string): `livefeed:${string}` =>
  `livefeed:${id}`;
/** Public control topic (`status`, `pin`, `comment_removed`, `stats`). */
export const streamTopic = (id: string): `stream:${string}` => `stream:${id}`;

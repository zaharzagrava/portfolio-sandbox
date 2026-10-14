import { Injectable } from '@nestjs/common';
import { CacheService, cacheKey } from '@app/infrastructure/cache';
import type {
  MessageRecord,
  ReadableChannel,
  RecentWindow,
} from '../domain/ports';

/** How many of the latest messages a cached tail holds: a reconnect after a short gap is served from it. */
export const RECENT_TAIL = 50;
const TTL_MS = 60_000;

interface Cached {
  items: Array<
    Omit<MessageRecord, 'createdAt' | 'deletedAt'> & {
      createdAt: string;
      deletedAt: string | null;
    }
  >;
}

const toCached = (messages: MessageRecord[]): Cached => ({
  items: messages.map((m) => ({
    ...m,
    createdAt: m.createdAt.toISOString(),
    deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
  })),
});
const fromCached = (c: Cached): MessageRecord[] =>
  c.items.map((m) => ({
    ...m,
    createdAt: new Date(m.createdAt),
    deletedAt: m.deletedAt ? new Date(m.deletedAt) : null,
  }));

/**
 * The tail of a channel, content-addressed by `(channel, lastSeq, deleteEpoch)` (R-10, G-20): a new message changes
 * `lastSeq` and a delete changes the epoch in the same transaction, so a changed tail has a new key and an old entry
 * is never served for it: a deleted body cannot come back from here. Tombstones are cached as tombstones.
 */
@Injectable()
export class RecentWindowCache implements RecentWindow {
  constructor(private readonly cache: CacheService) {}

  async tails(
    items: ReadableChannel[],
    load: (missing: ReadableChannel[]) => Promise<Map<string, MessageRecord[]>>,
  ): Promise<Map<string, MessageRecord[]>> {
    if (items.length === 0) return new Map();
    const keyOf = (c: ReadableChannel) =>
      cacheKey('chat-recent', 1, c.id, String(c.lastSeq), c.deleteEpoch);
    const keys = items.map(keyOf);
    const byKey = new Map(items.map((c) => [keyOf(c), c]));
    const found = await this.cache.getOrLoadMany<Cached>(
      keys,
      async (missing) => {
        const loaded = await load(missing.map((k) => byKey.get(k)!));
        return new Map(
          missing.map((k) => [k, toCached(loaded.get(byKey.get(k)!.id) ?? [])]),
        );
      },
      { ttlMs: TTL_MS, l1: 'never' },
    );
    return new Map(
      items.map((c, i) => [c.id, found[i] ? fromCached(found[i]!) : []]),
    );
  }
}

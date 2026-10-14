import { Inject, Injectable } from '@nestjs/common';
import type { ChatChannelSync } from '@marketplace-sandbox/contracts';
import { syncWindow } from '../domain/history-cursor';
import {
  PORTS,
  type MessageRecord,
  type ReadableChannel,
  type RecentWindow,
  type SyncRepository,
} from '../domain/ports';
import { toMessageView } from './chat-views';

/** Messages a cached tail holds; a gap this small is served from it (see `RecentWindowCache`). */
const RECENT_TAIL = 50;

/**
 * Sync on reconnect (S24 US3, FR-020 to FR-022): the delivery guarantee behind a best-effort push. For up to 50
 * channels a cold call runs three statements whatever the number of channels: the membership filter (with each
 * channel's last sequence), the index range of every window, and the bodies. A short gap at the tail of a channel is
 * served from the content-addressed tail cache (zero statements for it). Channels the caller cannot read are absent,
 * with no trace of their existence. A deleted body is never served after the delete committed: bodies come from the
 * rows, and the cache key carries the channel's delete epoch.
 */
@Injectable()
export class ChatSyncService {
  constructor(
    @Inject(PORTS.SyncRepository) private readonly repo: SyncRepository,
    @Inject(PORTS.RecentWindow) private readonly recent: RecentWindow,
  ) {}

  async sync(
    userId: string,
    cursors: Record<string, number>,
  ): Promise<ChatChannelSync[]> {
    const wanted = new Map<string, number>();
    for (const [id, cursor] of Object.entries(cursors))
      wanted.set(id.toLowerCase(), cursor);
    if (wanted.size === 0) return [];

    const readable = await this.repo.readable(userId, [...wanted.keys()]);
    const byId = new Map(readable.map((c) => [c.id, c]));
    const plans = [...wanted.entries()]
      .filter(([id]) => byId.has(id))
      .map(([id, cursor]) => {
        const channel = byId.get(id)!;
        return { channel, window: syncWindow(cursor, channel.lastSeq) };
      });

    const messages = new Map<string, MessageRecord[]>();
    const tails: ReadableChannel[] = [];
    const wide: Array<{ channelId: string; afterSeq: number; toSeq: number }> =
      [];
    for (const { channel, window } of plans) {
      if (window.toSeq < window.fromSeq) messages.set(channel.id, []);
      else if (
        window.toSeq === channel.lastSeq &&
        channel.lastSeq - window.fromSeq + 1 <= RECENT_TAIL
      )
        tails.push(channel);
      else
        wide.push({
          channelId: channel.id,
          afterSeq: window.fromSeq - 1,
          toSeq: window.toSeq,
        });
    }

    if (tails.length) {
      const loaded = await this.recent.tails(tails, (missing) =>
        this.repo.loadWindows(
          missing.map((c) => ({
            channelId: c.id,
            afterSeq: Math.max(0, c.lastSeq - RECENT_TAIL),
            toSeq: c.lastSeq,
          })),
        ),
      );
      for (const { channel, window } of plans) {
        const tail = loaded.get(channel.id);
        if (tail)
          messages.set(
            channel.id,
            tail.filter(
              (m) => m.seq >= window.fromSeq && m.seq <= window.toSeq,
            ),
          );
      }
    }
    if (wide.length) {
      for (const [id, list] of await this.repo.loadWindows(wide))
        messages.set(id, list);
    }

    return plans.map(({ channel, window }) => ({
      channelId: channel.id,
      messages: (messages.get(channel.id) ?? []).map(toMessageView),
      lastSeq: channel.lastSeq,
      hasMore: window.hasMore,
    }));
  }
}

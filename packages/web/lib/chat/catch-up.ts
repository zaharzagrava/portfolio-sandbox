import type { ChatChannelSync, ChatMessage } from '@marketplace-sandbox/contracts';

/**
 * The catch-up (W05 FR-041, AS-23..AS-25, AS-30): the one recovery routine of the chat. Push is best-effort, sync is the
 * guarantee: after a live hint, a (re)opened connection, `online`, a visible tab, `resync` and on the polling intervals
 * the page asks the server for everything after the highest `seq` it holds, merges it by `id`, and re-reads the inbox.
 */

/** Adds new messages, replaces re-delivered ones (same `id`), keeps `seq` order. The same array comes back when nothing arrives. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** `POST /chat/sync` refuses more than 50 chats as a whole (S24), so the page never sends more. */
export const CATCH_UP_MAX_CHATS = 50;
const MAX_ROUNDS = 100;

export type CatchUpDeps = {
  /** The highest `seq` held for every chat whose messages are loaded. Read at the start of every run. */
  cursors: () => Record<string, number>;
  /** `chatApi.sync`. */
  sync: (cursors: Record<string, number>) => Promise<ChatChannelSync[]>;
  /** Merge what arrived for one chat into the cache (called only when there are messages). */
  apply: (result: { channelId: string; messages: ChatMessage[]; lastSeq: number }) => void;
  /** The server's newest `seq` is below what the page holds (AS-30): discard that chat's messages and reload its newest page. */
  reset: (channelId: string) => Promise<void> | void;
  /** Re-read the inbox (badges and order) after the sync loop. */
  refreshInbox: () => Promise<void>;
};

export type CatchUp = {
  /**
   * Starts a catch-up, or joins the run in progress. Concurrent triggers share one run; a trigger during a run schedules
   * exactly one more run after it, and the returned promise settles when the run that covers this trigger has settled.
   * It rejects when a call failed, so the caller keeps its banner until a full catch-up has completed.
   */
  run: () => Promise<void>;
};

async function runOnce(deps: CatchUpDeps): Promise<void> {
  let cursors: Record<string, number> = Object.fromEntries(Object.entries(deps.cursors()).slice(0, CATCH_UP_MAX_CHATS));
  for (let round = 0; round < MAX_ROUNDS && Object.keys(cursors).length > 0; round++) {
    const results = await deps.sync(cursors);
    const next: Record<string, number> = {};
    for (const result of results) {
      const held = cursors[result.channelId];
      if (held === undefined) continue;
      if (result.lastSeq < held) {
        await deps.reset(result.channelId);
        continue;
      }
      if (result.messages.length === 0) continue;
      deps.apply({ channelId: result.channelId, messages: result.messages, lastSeq: result.lastSeq });
      if (result.hasMore) next[result.channelId] = Math.max(held, ...result.messages.map((message) => message.seq));
    }
    cursors = next;
  }
  await deps.refreshInbox();
}

export function createCatchUp(deps: CatchUpDeps): CatchUp {
  let current: Promise<void> | null = null;
  let trailing: Promise<void> | null = null;

  const start = (): Promise<void> => {
    const promise = runOnce(deps).finally(() => {
      if (current === promise) current = null;
    });
    current = promise;
    return promise;
  };

  return {
    run() {
      if (!current) return start();
      if (!trailing) {
        // One more run after the one in progress, whatever its outcome: the trigger arrived after its cursors were read.
        const after = () => {
          trailing = null;
          return start();
        };
        trailing = current.then(after, after);
      }
      return trailing;
    },
  };
}

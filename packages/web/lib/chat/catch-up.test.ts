import type { ChatChannelSync, ChatMessage } from '@marketplace-sandbox/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createCatchUp, mergeMessages, type CatchUpDeps } from './catch-up';

const CH1 = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const CH2 = '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f';
const USER = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';

const id = (seq: number) => `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
const msg = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({ id: id(seq), seq, authorId: USER, body: `m${seq}`, replyToId: null, createdAt: '2026-10-01T10:00:00.000Z', deleted: false, ...over });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
const entry = (channelId: string, messages: ChatMessage[], over: Partial<ChatChannelSync> = {}): ChatChannelSync => ({ channelId, messages, lastSeq: messages.at(-1)?.seq ?? 0, hasMore: false, ...over });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function setup(over: Partial<CatchUpDeps> = {}) {
  const calls: string[] = [];
  const deps: CatchUpDeps = {
    cursors: () => ({ [CH1]: 10 }),
    sync: vi.fn(async () => {
      calls.push('sync');
      return [];
    }),
    apply: vi.fn((result) => void calls.push(`apply:${result.channelId}:${result.messages.length}`)),
    reset: vi.fn(async (channelId: string) => void calls.push(`reset:${channelId}`)),
    refreshInbox: vi.fn(async () => void calls.push('inbox')),
    ...over,
  };
  return { deps, calls, catchUp: createCatchUp(deps) };
}

describe('Chat catch-up', () => {
  it('W05 AS-25 UC9: mergeMessages merges by id (a re-delivered message replaces its copy) and orders by seq', () => {
    const held = [msg(1), msg(2), msg(3)];
    const merged = mergeMessages(held, [msg(5), msg(4), msg(2, { deleted: true, body: null })]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(merged[1]).toMatchObject({ seq: 2, deleted: true, body: null });
    expect(held[1].deleted).toBe(false);
    expect(mergeMessages([], [msg(2), msg(1), msg(2)]).map((m) => m.seq)).toEqual([1, 2]);
  });

  it('W05 AS-25 UC9: nothing incoming changes nothing (the same array comes back)', () => {
    const held = [msg(1)];
    expect(mergeMessages(held, [])).toBe(held);
  });

  it('W05 AS-25 UC9: a catch-up sends the cursor of every loaded chat in one call, then reads the inbox, in that order', async () => {
    const { catchUp, deps, calls } = setup({
      cursors: () => ({ [CH1]: 10, [CH2]: 3 }),
      sync: vi.fn(async () => [entry(CH1, [msg(11)]), entry(CH2, [msg(4), msg(5)])]),
      apply: vi.fn((r) => void calls.push(`apply:${r.channelId}:${r.messages.length}`)),
    });
    await catchUp.run();
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(deps.sync).toHaveBeenCalledWith({ [CH1]: 10, [CH2]: 3 });
    expect(calls).toEqual([`apply:${CH1}:1`, `apply:${CH2}:2`, 'inbox']);
  });

  it('W05 AS-25 UC9: a chat that answers hasMore is asked again from its highest seq until it answers false; the others are not asked again', async () => {
    const answers = [
      [entry(CH1, range(11, 60), { hasMore: true, lastSeq: 120 }), entry(CH2, [msg(4)], { lastSeq: 4 })],
      [entry(CH1, range(61, 110), { hasMore: true, lastSeq: 120 })],
      [entry(CH1, range(111, 120), { lastSeq: 120 })],
    ];
    const sync = vi.fn(async () => answers.shift()!);
    const { catchUp, deps } = setup({ cursors: () => ({ [CH1]: 10, [CH2]: 3 }), sync });
    await catchUp.run();
    expect(sync.mock.calls).toEqual([[{ [CH1]: 10, [CH2]: 3 }], [{ [CH1]: 60 }], [{ [CH1]: 110 }]]);
    expect(deps.apply).toHaveBeenCalledTimes(4);
    expect(deps.refreshInbox).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-25 UC9: hasMore with no messages never loops forever', async () => {
    const sync = vi.fn(async () => [entry(CH1, [], { hasMore: true, lastSeq: 99 })]);
    const { catchUp } = setup({ sync });
    await catchUp.run();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-25 UC9: a chat that answers with no messages changes nothing', async () => {
    const { catchUp, deps } = setup({ sync: vi.fn(async () => [entry(CH1, [], { lastSeq: 10 })]) });
    await catchUp.run();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(deps.reset).not.toHaveBeenCalled();
  });

  it('W05 AS-25 UC9: at most 50 chats are sent in one call (the server refuses more than 50 as a whole)', async () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, i]));
    const { catchUp, deps } = setup({ cursors: () => many });
    await catchUp.run();
    const sent = (deps.sync as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, number>;
    expect(Object.keys(sent)).toHaveLength(50);
    expect(Object.keys(sent)).toEqual(Object.keys(many).slice(0, 50));
  });

  it('W05 AS-25 UC9: no loaded chat means no call at all (the inbox is still read)', async () => {
    const { catchUp, deps } = setup({ cursors: () => ({}) });
    await catchUp.run();
    expect(deps.sync).not.toHaveBeenCalled();
    expect(deps.refreshInbox).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-25 UC9: concurrent triggers share one run and a trigger during a run schedules exactly one more run after it', async () => {
    const first = deferred<ChatChannelSync[]>();
    const sync = vi
      .fn<(cursors: Record<string, number>) => Promise<ChatChannelSync[]>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => []);
    const { catchUp } = setup({ sync });
    const a = catchUp.run();
    const b = catchUp.run();
    const c = catchUp.run();
    const d = catchUp.run();
    expect(sync).toHaveBeenCalledTimes(1);
    first.resolve([]);
    await Promise.all([a, b, c, d]);
    expect(sync).toHaveBeenCalledTimes(2);
    await catchUp.run();
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it('W05 AS-25 UC9: the trailing run reads the cursors again (it sees what the first run applied)', async () => {
    let held = 10;
    const first = deferred<ChatChannelSync[]>();
    const sync = vi
      .fn<(cursors: Record<string, number>) => Promise<ChatChannelSync[]>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => []);
    const { catchUp } = setup({ sync, cursors: () => ({ [CH1]: held }), apply: vi.fn(() => void (held = 12)) });
    const a = catchUp.run();
    const b = catchUp.run();
    first.resolve([entry(CH1, [msg(11), msg(12)])]);
    await Promise.all([a, b]);
    expect(sync.mock.calls.map(([cursors]) => cursors)).toEqual([{ [CH1]: 10 }, { [CH1]: 12 }]);
  });

  it('W05 AS-30 UC9: a cursor ahead of the server discards what is held for that chat and reloads its newest page; other chats continue', async () => {
    const { catchUp, deps, calls } = setup({
      cursors: () => ({ [CH1]: 40, [CH2]: 3 }),
      sync: vi.fn(async () => [entry(CH1, [], { lastSeq: 25, hasMore: false }), entry(CH2, [msg(4)])]),
      apply: vi.fn((r) => void calls.push(`apply:${r.channelId}:${r.messages.length}`)),
    });
    await catchUp.run();
    expect(deps.reset).toHaveBeenCalledTimes(1);
    expect(deps.reset).toHaveBeenCalledWith(CH1);
    expect(calls.at(-1)).toBe('inbox');
    expect(calls).toContain(`apply:${CH2}:1`);
    expect(calls).not.toContain(`apply:${CH1}:0`);
  });

  it('W05 AS-30 UC9: a cursor ahead is not asked again in the hasMore loop', async () => {
    const answers = [[entry(CH1, [], { lastSeq: 5 }), entry(CH2, range(4, 53), { hasMore: true, lastSeq: 90 })], [entry(CH2, range(54, 90))]];
    const sync = vi.fn<(cursors: Record<string, number>) => Promise<ChatChannelSync[]>>(async () => answers.shift()!);
    const { catchUp } = setup({ cursors: () => ({ [CH1]: 40, [CH2]: 3 }), sync });
    await catchUp.run();
    expect(sync.mock.calls[1][0]).toEqual({ [CH2]: 53 });
  });

  it('W05 AS-24 UC9: a failed sync rejects the run, skips the inbox read, and the next trigger runs again', async () => {
    const sync = vi.fn<(cursors: Record<string, number>) => Promise<ChatChannelSync[]>>().mockRejectedValueOnce(new Error('network')).mockResolvedValue([]);
    const { catchUp, deps } = setup({ sync });
    await expect(catchUp.run()).rejects.toThrow('network');
    expect(deps.refreshInbox).not.toHaveBeenCalled();
    await expect(catchUp.run()).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(deps.refreshInbox).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-25 UC9: a failed inbox read rejects the run too (the banner stays until a full catch-up completes)', async () => {
    const { catchUp } = setup({ refreshInbox: vi.fn().mockRejectedValue(new Error('inbox')) });
    await expect(catchUp.run()).rejects.toThrow('inbox');
  });
});

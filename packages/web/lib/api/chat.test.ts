import { describe, expect, it } from 'vitest';
import { mergeMessages, type ChatMessage } from './chat';

const msg = (seq: number, body = `m${seq}`): ChatMessage => ({ id: `id-${seq}`, seq, authorId: 'u', body, createdAt: '', deleted: false });

describe('mergeMessages', () => {
  it('appends new messages in seq order', () => {
    expect(mergeMessages([msg(1), msg(2)], [msg(4), msg(3)]).map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });

  it('a re-delivered message (same id) replaces the old copy instead of duplicating', () => {
    const merged = mergeMessages([msg(1), msg(2)], [{ ...msg(2), deleted: true, body: null }]);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ seq: 2, deleted: true });
  });

  it('returns the same array when nothing arrives', () => {
    const current = [msg(1)];
    expect(mergeMessages(current, [])).toBe(current);
  });
});

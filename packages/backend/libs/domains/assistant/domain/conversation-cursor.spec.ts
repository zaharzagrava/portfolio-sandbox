import { decodeConversationCursor, encodeConversationCursor } from './conversation-cursor';

const ID = '8c1f2a40-b0a1-11f0-9c5e-0242ac120002'; // time-UUID (v1)

describe('S46 conversation cursor', () => {
  it('S46 AS-08: round trips the last conversation id as base64url', () => {
    const cursor = encodeConversationCursor(ID);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeConversationCursor(cursor)).toBe(ID);
  });

  it.each([
    ['not base64url', '***'],
    ['empty', ''],
    ['base64url of a non uuid', Buffer.from('hello').toString('base64url')],
    ['base64url of a v4 uuid', Buffer.from('3b241101-e2bb-4255-8caf-4136c566a962').toString('base64url')],
    ['standard base64 with padding', Buffer.from(ID).toString('base64') + '=='],
  ])('S46 AS-08: %s is rejected', (_n, cursor) => {
    expect(decodeConversationCursor(cursor)).toBeNull();
  });
});

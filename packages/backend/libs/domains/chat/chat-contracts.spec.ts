import {
  CHAT_ERROR_CODES,
  chatChannelSchema,
  chatChannelSyncSchema,
  chatErrorCodeSchema,
  chatMessagePageSchema,
  chatSyncRequestSchema,
  chatUnreadPageSchema,
  chatWsTicketSchema,
  createChannelRequestSchema,
  chatMarkReadRequestSchema as markReadRequestSchema,
  chatMarkReadResponseSchema as markReadResponseSchema,
  presenceResponseSchema,
  sendMessageRequestSchema,
  sendMessageResponseSchema,
  updateChannelRequestSchema,
} from '@marketplace-sandbox/contracts';

const id = '0192f3a0-0000-7000-8000-000000000001';
const user = '0192f3a0-0000-7000-8000-000000000002';
const t0 = '2030-01-01T10:00:00.000Z';

const message = {
  id,
  seq: 3,
  authorId: user,
  body: 'hi',
  replyToId: null,
  createdAt: t0,
  deleted: false,
};
const channel = {
  id,
  productId: id,
  shopId: id,
  sellerId: user,
  title: 'Chat',
  isArchived: false,
  archivedAt: null,
  createdAt: t0,
  updatedAt: t0,
  myRole: null,
};
const uuid = (i: number) =>
  `0192f3a0-0000-7000-8000-${String(i).padStart(12, '0')}`;

describe('S24 contracts: HTTP schemas', () => {
  it('S24 AS-01: every sample body of contracts/http.md parses', () => {
    expect(chatChannelSchema.parse(channel)).toEqual(channel);
    expect(createChannelRequestSchema.parse({ productId: id })).toEqual({
      productId: id,
    });
    expect(updateChannelRequestSchema.parse({ isArchived: true })).toEqual({
      isArchived: true,
    });
    expect(
      sendMessageRequestSchema.parse({ clientMessageId: id, body: '  hi  ' })
        .body,
    ).toBe('hi');
    expect(
      sendMessageResponseSchema.parse({ message, duplicate: false }).duplicate,
    ).toBe(false);
    expect(
      chatMessagePageSchema.parse({ items: [message], nextCursor: null }).items,
    ).toHaveLength(1);
    expect(
      chatSyncRequestSchema.parse({ cursors: { [id]: 0 } }).cursors[id],
    ).toBe(0);
    expect(
      chatChannelSyncSchema.parse({
        channelId: id,
        messages: [message],
        lastSeq: 3,
        hasMore: false,
      }).hasMore,
    ).toBe(false);
    expect(
      chatUnreadPageSchema.parse({
        items: [{ channelId: id, unread: 2, lastSeq: 3 }],
        nextCursor: null,
      }).items,
    ).toHaveLength(1);
    expect(markReadRequestSchema.parse({ seq: 3 })).toEqual({ seq: 3 });
    expect(markReadResponseSchema.parse({ lastReadSeq: 3, unread: 0 })).toEqual(
      { lastReadSeq: 3, unread: 0 },
    );
    expect(
      presenceResponseSchema.parse({ [user]: { online: true, lastSeenAt: 1 } })[
        user
      ].online,
    ).toBe(true);
    expect(
      chatWsTicketSchema.parse({
        ticket: 'x',
        wsUrl: 'wss://h/ws',
        expiresAt: t0,
      }).ticket,
    ).toBe('x');
  });

  it('S24 AS-16: message body is trimmed and bounded, key must be a UUID', () => {
    expect(
      sendMessageRequestSchema.safeParse({ clientMessageId: id, body: '   ' })
        .success,
    ).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({
        clientMessageId: id,
        body: 'x'.repeat(4001),
      }).success,
    ).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({
        clientMessageId: id,
        body: '😀'.repeat(4000),
      }).success,
    ).toBe(true);
    expect(
      sendMessageRequestSchema.safeParse({ clientMessageId: 'nope', body: 'a' })
        .success,
    ).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({
        clientMessageId: id,
        body: 'a',
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('S24 AS-25: sync cursors are UUID keys with safe non-negative integers, at most 50', () => {
    const keys = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [uuid(i), 0]));
    expect(chatSyncRequestSchema.safeParse({ cursors: keys(50) }).success).toBe(
      true,
    );
    expect(chatSyncRequestSchema.safeParse({ cursors: keys(51) }).success).toBe(
      false,
    );
    for (const bad of [-1, 1.5, 2 ** 53, '3']) {
      expect(
        chatSyncRequestSchema.safeParse({ cursors: { [id]: bad } }).success,
      ).toBe(false);
    }
    expect(
      chatSyncRequestSchema.safeParse({ cursors: { nope: 1 } }).success,
    ).toBe(false);
    expect(markReadRequestSchema.safeParse({ seq: 2 ** 53 }).success).toBe(
      false,
    );
    expect(markReadRequestSchema.safeParse({ seq: 1.5 }).success).toBe(false);
  });

  it('S24 AS-39: presence answers are keyed by UUID', () => {
    expect(
      presenceResponseSchema.safeParse({
        nope: { online: true, lastSeenAt: null },
      }).success,
    ).toBe(false);
  });

  it('S24 AS-04: title is 1–120 characters and an update names at least one field', () => {
    expect(
      createChannelRequestSchema.safeParse({ productId: id, title: '' })
        .success,
    ).toBe(false);
    expect(
      createChannelRequestSchema.safeParse({
        productId: id,
        title: 'x'.repeat(121),
      }).success,
    ).toBe(false);
    expect(updateChannelRequestSchema.safeParse({}).success).toBe(false);
  });

  it('S24 AS-17: the error-code enum is complete', () => {
    const expected = [
      'validation_failed',
      'too_many_channels',
      'channel_not_found',
      'member_not_found',
      'message_not_found',
      'product_not_found',
      'forbidden',
      'banned',
      'muted',
      'channel_archived',
      'invalid_transition',
      'channel_exists',
      'idempotency_conflict',
      'presence_unavailable',
    ];
    for (const code of expected)
      expect(chatErrorCodeSchema.safeParse(code).success).toBe(true);
    expect([...CHAT_ERROR_CODES]).toEqual(expect.arrayContaining(expected));
  });
});

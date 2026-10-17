import {
  chatHubEventSchema,
  chatInboxPageSchema,
  chatReceiptsSchema,
} from '@marketplace-sandbox/contracts';

const id = (n: number) => `0196b0f0-0000-7000-8000-00000000000${n}`;
const channel = {
  id: id(1),
  productId: id(2),
  shopId: id(3),
  sellerId: id(4),
  title: 'Bike',
  isArchived: false,
  archivedAt: null,
  createdAt: '2026-10-14T12:00:00.000Z',
  updatedAt: '2026-10-14T12:00:00.000Z',
  myRole: 'MEMBER',
};

describe('W05 chat contracts (inbox, receipts, hub events)', () => {
  it('W05 AS-07: a page of channels with unread, lastSeq and lastMessageAt parses', () => {
    const page = {
      items: [{ ...channel, unread: 2, lastSeq: 5, lastMessageAt: null }],
      nextCursor: null,
    };
    expect(chatInboxPageSchema.safeParse(page).success).toBe(true);
  });

  it('W05 AS-07: an inbox item without the unread count is refused', () => {
    const page = {
      items: [{ ...channel, lastSeq: 5, lastMessageAt: null }],
      nextCursor: null,
    };
    expect(chatInboxPageSchema.safeParse(page).success).toBe(false);
  });

  it('W05 AS-33: receipts parse, a suppressed answer parses, a negative position is refused', () => {
    expect(
      chatReceiptsSchema.safeParse({
        items: [{ userId: id(1), lastReadSeq: 3 }],
        suppressed: false,
      }).success,
    ).toBe(true);
    expect(
      chatReceiptsSchema.safeParse({ items: [], suppressed: true }).success,
    ).toBe(true);
    expect(
      chatReceiptsSchema.safeParse({
        items: [{ userId: id(1), lastReadSeq: -1 }],
        suppressed: false,
      }).success,
    ).toBe(false);
  });

  it.each([
    { type: 'message', data: { channelId: id(1), messageId: id(2), seq: 4 } },
    { type: 'message_deleted', data: { channelId: id(1), messageId: id(2) } },
    { type: 'channel_archived', data: { channelId: id(1) } },
    { type: 'read', data: { userId: id(2), seq: 3 } },
    {
      type: 'presence',
      data: { userId: id(2), online: true, ttlSeconds: 60 },
    },
  ])('W05 AS-23: hub event $type parses', (event) => {
    expect(chatHubEventSchema.safeParse(event).success).toBe(true);
  });

  it('W05 AS-23: an unknown hub event type and a message without seq are refused', () => {
    expect(chatHubEventSchema.safeParse({ type: 'other', data: {} }).success).toBe(false);
    expect(
      chatHubEventSchema.safeParse({
        type: 'message',
        data: { channelId: id(1), messageId: id(2) },
      }).success,
    ).toBe(false);
  });
});

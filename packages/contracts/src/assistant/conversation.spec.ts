import {
  ASSISTANT_CONVERSATION_LIST_LIMIT,
  ASSISTANT_DEFAULT_TITLE,
  assistantConversationIdSchema,
  assistantConversationListQuerySchema,
  assistantConversationListSchema,
  assistantConversationSchema,
  assistantCreateConversationRequestSchema,
} from './conversation.ts';
import { assistantHistorySchema } from './history.ts';
import { assistantUsageSchema } from './usage.ts';

const ok = (r: { success: boolean }) => r.success;
const ID = '0192b0a0-0000-7000-8000-000000000001';
const now = '2026-10-15T12:00:00.000Z';
const conversation = {
  id: ID,
  title: 'Phones',
  updatedAt: now,
  messageCount: 0,
};

describe('S46 conversation contracts (parse tests)', () => {
  it('S46 AS-03: the title is trimmed and defaults to "New chat"', () => {
    const empty = assistantCreateConversationRequestSchema.parse({});
    expect(empty.title).toBe(ASSISTANT_DEFAULT_TITLE);
    expect(ASSISTANT_DEFAULT_TITLE).toBe('New chat');
    expect(
      assistantCreateConversationRequestSchema.parse({ title: '  Phones ' })
        .title,
    ).toBe('Phones');
  });

  it.each<[string, unknown, boolean]>([
    ['1 character', { title: 'a' }, true],
    ['120 characters', { title: 'a'.repeat(120) }, true],
    ['120 characters plus padding', { title: ` ${'a'.repeat(120)} ` }, true],
    ['0 characters', { title: '' }, false],
    ['only spaces', { title: '   ' }, false],
    ['121 characters', { title: 'a'.repeat(121) }, false],
    ['a number', { title: 5 }, false],
    ['an unknown field', { title: 'x', userId: ID }, false],
  ])('S46 AS-03: a title of %s', (_n, body, valid) => {
    expect(ok(assistantCreateConversationRequestSchema.safeParse(body))).toBe(
      valid,
    );
  });

  it('S46 AS-03: the conversation id must be a time-based UUID', () => {
    for (const id of [ID, '0192b0a0-0000-1000-8000-000000000001']) {
      expect(ok(assistantConversationIdSchema.safeParse(id))).toBe(true);
    }
    for (const id of [
      'not-a-uuid',
      '',
      '123',
      '550e8400-e29b-41d4-a716-446655440000', // version 4: random, not time-based
      `${ID}x`,
    ]) {
      expect(ok(assistantConversationIdSchema.safeParse(id))).toBe(false);
    }
  });

  it('S46 AS-07: a conversation and a page of them parse; nextCursor is a string or null', () => {
    expect(ok(assistantConversationSchema.safeParse(conversation))).toBe(true);
    expect(
      ok(
        assistantConversationListSchema.safeParse({
          items: [conversation],
          nextCursor: 'abc',
        }),
      ),
    ).toBe(true);
    expect(
      ok(
        assistantConversationListSchema.safeParse({
          items: [],
          nextCursor: null,
        }),
      ),
    ).toBe(true);
    expect(ok(assistantConversationListSchema.safeParse({ items: [] }))).toBe(
      false,
    );
    expect(
      ok(
        assistantConversationSchema.safeParse({
          ...conversation,
          messageCount: -1,
        }),
      ),
    ).toBe(false);
    expect(
      ok(
        assistantConversationSchema.safeParse({ ...conversation, userId: ID }),
      ),
    ).toBe(false);
  });

  it('S46 AS-07: the list limit is 1 to 50 and defaults to 20', () => {
    expect(ASSISTANT_CONVERSATION_LIST_LIMIT).toEqual({
      min: 1,
      max: 50,
      default: 20,
    });
    expect(assistantConversationListQuerySchema.parse({}).limit).toBe(20);
    expect(
      assistantConversationListQuerySchema.parse({ limit: '10' }).limit,
    ).toBe(10);
    expect(
      assistantConversationListQuerySchema.parse({ limit: '1' }).limit,
    ).toBe(1);
    expect(
      assistantConversationListQuerySchema.parse({ limit: '50' }).limit,
    ).toBe(50);
    for (const limit of ['0', '51', '-1', '1.5', 'abc']) {
      expect(
        ok(assistantConversationListQuerySchema.safeParse({ limit })),
      ).toBe(false);
    }
  });

  it('S46 AS-07: a cursor is an optional string of at most 512 characters; unknown query fields are refused', () => {
    expect(
      ok(assistantConversationListQuerySchema.safeParse({ cursor: 'abc' })),
    ).toBe(true);
    expect(
      ok(
        assistantConversationListQuerySchema.safeParse({
          cursor: 'a'.repeat(512),
        }),
      ),
    ).toBe(true);
    expect(
      ok(
        assistantConversationListQuerySchema.safeParse({
          cursor: 'a'.repeat(513),
        }),
      ),
    ).toBe(false);
    expect(
      ok(assistantConversationListQuerySchema.safeParse({ userId: ID })),
    ).toBe(false);
  });

  it('S46 AS-08: history items are {id, turnId, role, text, tools}', () => {
    const message = {
      id: 'm1',
      turnId: 't1',
      role: 'assistant',
      text: 'Hello',
      tools: ['search_products'],
    };
    const history = {
      conversation: { id: ID, title: 'Phones', updatedAt: now },
      messages: [{ ...message, role: 'user', tools: [] }, message],
    };
    expect(ok(assistantHistorySchema.safeParse(history))).toBe(true);
    expect(
      ok(assistantHistorySchema.safeParse({ ...history, messages: [] })),
    ).toBe(true);
    for (const bad of [
      { ...message, role: 'system' },
      { ...message, tools: 'search_products' },
      { ...message, thinking: 'secret' },
      { ...message, toolInput: {} },
      { id: 'm1', turnId: 't1', role: 'user', text: 'x' },
    ]) {
      expect(
        ok(assistantHistorySchema.safeParse({ ...history, messages: [bad] })),
      ).toBe(false);
    }
  });

  it('S46 AS-42: the usage body is {used, limit, resetsAt} with an ISO instant', () => {
    expect(
      ok(
        assistantUsageSchema.safeParse({
          used: 0,
          limit: 2_000_000,
          resetsAt: '2026-11-01T00:00:00.000Z',
        }),
      ),
    ).toBe(true);
    for (const bad of [
      { used: -1, limit: 10, resetsAt: now },
      { used: 1.5, limit: 10, resetsAt: now },
      { used: 1, limit: 10, resetsAt: 'tomorrow' },
      { used: 1, limit: 10 },
      { used: 1, limit: 10, resetsAt: now, userId: ID },
    ]) {
      expect(ok(assistantUsageSchema.safeParse(bad))).toBe(false);
    }
  });
});

import {
  SYNC_PAGE_SIZE,
  decodeHistoryCursor,
  decodeUnreadCursor,
  encodeHistoryCursor,
  encodeUnreadCursor,
  syncWindow,
} from './history-cursor';

describe('S24 cursors', () => {
  it.each([1, 20, 450, Number.MAX_SAFE_INTEGER])(
    'S24 AS-27: the history cursor %i round-trips',
    (seq) => {
      const c = encodeHistoryCursor(seq);
      expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeHistoryCursor(c)).toBe(seq);
    },
  );

  it.each([
    ['empty', ''],
    ['not base64url', '***'],
    ['not json', Buffer.from('nope').toString('base64url')],
    ['no seq', Buffer.from('{}').toString('base64url')],
    ['seq as string', Buffer.from('{"seq":"3"}').toString('base64url')],
    ['fractional seq', Buffer.from('{"seq":1.5}').toString('base64url')],
    ['zero seq', Buffer.from('{"seq":0}').toString('base64url')],
    ['negative seq', Buffer.from('{"seq":-4}').toString('base64url')],
    [
      'unsafe seq',
      Buffer.from('{"seq":9007199254740993}').toString('base64url'),
    ],
    ['array', Buffer.from('[3]').toString('base64url')],
  ])('S24 AS-27: a %s cursor is refused', (_label, c) => {
    expect(decodeHistoryCursor(c)).toBeNull();
  });

  it.each([
    '2030-01-01 10:00:00+00',
    '2030-01-01 10:00:00.123456+00',
    '2030-01-01 12:00:00.5+02',
    '2030-01-01 10:00:00.123456+05:30',
  ])(
    'S24 AS-30: the unread cursor keeps the activity time as the database printed it (%s)',
    (at) => {
      const id = '0192f3a0-0000-7000-8000-000000000001';
      expect(decodeUnreadCursor(encodeUnreadCursor(at, id))).toEqual({
        at,
        channelId: id,
      });
    },
  );

  it.each([
    ['not base64url', '***'],
    [
      'not a timestamp',
      Buffer.from(
        '{"at":"x","channelId":"0192f3a0-0000-7000-8000-000000000001"}',
      ).toString('base64url'),
    ],
    [
      'not a channel id',
      Buffer.from('{"at":"2030-01-01 10:00:00+00","channelId":"y"}').toString(
        'base64url',
      ),
    ],
    [
      'a timestamp with SQL in it',
      Buffer.from(
        '{"at":"2030-01-01 10:00:00+00\';--","channelId":"0192f3a0-0000-7000-8000-000000000001"}',
      ).toString('base64url'),
    ],
    [
      'a number for the time',
      Buffer.from(
        '{"at":5,"channelId":"0192f3a0-0000-7000-8000-000000000001"}',
      ).toString('base64url'),
    ],
  ])('S24 AS-30: an unread cursor that is %s is refused', (_label, cursor) => {
    expect(decodeUnreadCursor(cursor)).toBeNull();
  });

  describe('sync window', () => {
    it('S24 AS-22: 450 messages come in pages of 200 with hasMore, each message once', () => {
      expect(SYNC_PAGE_SIZE).toBe(200);
      expect(syncWindow(0, 450)).toEqual({
        fromSeq: 1,
        toSeq: 200,
        hasMore: true,
      });
      expect(syncWindow(200, 450)).toEqual({
        fromSeq: 201,
        toSeq: 400,
        hasMore: true,
      });
      expect(syncWindow(400, 450)).toEqual({
        fromSeq: 401,
        toSeq: 450,
        hasMore: false,
      });
    });

    it.each([
      [0, 0, { fromSeq: 1, toSeq: 0, hasMore: false }],
      [450, 450, { fromSeq: 451, toSeq: 450, hasMore: false }],
      [900, 450, { fromSeq: 901, toSeq: 450, hasMore: false }],
      [0, 200, { fromSeq: 1, toSeq: 200, hasMore: false }],
      [0, 201, { fromSeq: 1, toSeq: 200, hasMore: true }],
    ])('S24 AS-25: cursor %i with lastSeq %i', (cursor, lastSeq, expected) => {
      expect(syncWindow(cursor, lastSeq)).toEqual(expected);
    });
  });
});

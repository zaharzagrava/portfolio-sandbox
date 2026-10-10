import {
  comparePositions,
  decideReplay,
  decodeCursor,
  encodeCursor,
  parseTopicShape,
  resolveRoute,
  retentionCutoffMs,
  retryDelayMs,
  type RouteTable,
} from './topics';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const HOUR = 3_600_000;
const pos = (ms: number, seq = 0) => `${ms}-${seq}`;

describe('S51 topic grammar and route resolution', () => {
  const routes: RouteTable = new Map([
    ['auction', { singleton: false }],
    ['user', { singleton: false }],
    ['order-export', { singleton: false }],
    ['shop:live', { singleton: false }],
    ['shop:assets', { singleton: false }],
    ['flags', { singleton: true }],
  ]);

  it.each([
    ['auction:a1', 'auction', 'a1', null],
    ['order-export:0b9d-41', 'order-export', '0b9d-41', null],
    ['shop:s1:live', 'shop', 's1', 'live'],
    ['flags', 'flags', null, null],
  ])('S51 AS-04/AS-62: %s has a valid shape', (topic, prefix, id, suffix) => {
    expect(parseTopicShape(topic)).toEqual({ prefix, id, suffix });
  });

  it.each([
    ['empty id', 'user:'],
    ['upper-case prefix', 'USER:abc'],
    ['too many segments', 'auction:a1:x:y'],
    ['65-character id', `auction:${'a'.repeat(65)}`],
    ['illegal id character', 'auction:a.1'],
    ['33-character prefix', `${'a'.repeat(33)}:x`],
    ['prefix starting with a hyphen', '-a:x'],
    ['empty string', ''],
    ['empty suffix', 'shop:s1:'],
  ])('S51 AS-04: rejects %s', (_label, topic) => {
    expect(parseTopicShape(topic)).toBeNull();
  });

  it.each([
    ['auction:a1', 'auction'],
    ['order-export:abc', 'order-export'],
    ['shop:X:live', 'shop:live'],
    ['shop:X:assets', 'shop:assets'],
    ['flags', 'flags'],
  ])('S51 AS-62: %s resolves to route %s', (topic, key) => {
    expect(resolveRoute(topic, routes)?.key).toBe(key);
  });

  it.each([
    ['bare topic of a suffix-only prefix', 'shop:X'],
    ['suffix nobody defined', 'shop:X:other'],
    ['prefix nobody defined', 'nosuch:1'],
    ['singleton with an id', 'flags:x'],
    ['id-route used without id', 'auction'],
    ['suffix on a route without suffixes', 'auction:a1:live'],
  ])('S51 AS-62/AS-04: %s is unroutable', (_label, topic) => {
    expect(resolveRoute(topic, routes)).toBeNull();
  });

  it('S51 AS-62: a resolved route carries id and suffix', () => {
    expect(resolveRoute('shop:S9:assets', routes)).toEqual({
      key: 'shop:assets',
      prefix: 'shop',
      id: 'S9',
      suffix: 'assets',
    });
  });
});

describe('S51 AS-15 cursor decoding', () => {
  const requested = new Set(['auction:a1', 'auction:a2']);
  const decode = (raw: string | undefined) =>
    decodeCursor(raw, { isRequested: (t) => requested.has(t), now: NOW });
  const ok = pos(NOW - 1000, 3);

  it.each([
    ['a single valid entry', `auction:a1~${ok}`, [['auction:a1', ok]], 0],
    [
      'two valid entries',
      `auction:a1~${ok}|auction:a2~${pos(NOW - 5)}`,
      [
        ['auction:a1', ok],
        ['auction:a2', pos(NOW - 5)],
      ],
      0,
    ],
    ['garbage', 'garbage', [], 1],
    ['a non-numeric position', 'auction:a1~abc', [], 1],
    ['position 0-0', 'auction:a1~0-0', [], 1],
    [
      'duplicate entries: the first wins',
      `auction:a1~${pos(1, 1)}|auction:a1~${pos(2, 2)}`,
      [['auction:a1', pos(1, 1)]],
      1,
    ],
    ['a topic that was not requested', `auction:zz~${ok}`, [], 1],
    [
      'a position more than a minute in the future',
      `auction:a1~${pos(NOW + 61_000)}`,
      [],
      1,
    ],
    [
      'a position within the one-minute tolerance',
      `auction:a1~${pos(NOW + 59_000)}`,
      [['auction:a1', pos(NOW + 59_000)]],
      0,
    ],
    ['an empty string', '', [], 0],
    ['undefined', undefined, [], 0],
    [
      'a header longer than 2,048 characters',
      `auction:a1~${ok}|${'x'.repeat(2048)}`,
      [],
      1,
    ],
    ['a position with 17 digits', `auction:a1~${'1'.repeat(17)}-1`, [], 1],
  ])('S51 AS-15: %s', (_label, raw, entries, ignored) => {
    const result = decode(raw);
    expect([...result.cursor.entries()]).toEqual(entries);
    expect(result.ignored).toBe(ignored);
  });

  it('S51 AS-02: encodes every topic with a position, joined by |', () => {
    const cursor = new Map([
      ['auction:a1', '5-1'],
      ['auction:a2', '7-0'],
    ]);
    expect(encodeCursor(cursor)).toBe('auction:a1~5-1|auction:a2~7-0');
  });

  it.each([
    ['5-1', '5-2', -1],
    ['6-0', '5-9', 1],
    ['5-1', '5-1', 0],
    ['10-0', '9-0', 1],
  ])('compares %s with %s', (a, b, sign) => {
    expect(Math.sign(comparePositions(a, b))).toBe(sign);
  });
});

describe('S51 AS-16/AS-17/AS-18 resync decision', () => {
  const base = {
    now: NOW,
    retentionMs: HOUR,
    exists: true,
    latestId: pos(NOW - 1000, 5),
    maxDeletedId: '0-0',
  };

  it.each([
    [
      'AS-08: events after the cursor are replayed',
      { cursor: pos(NOW - 5000, 0) },
      'replay',
    ],
    [
      'AS-18: cursor equals latest: nothing',
      { cursor: pos(NOW - 1000, 5) },
      'nothing',
    ],
    [
      'AS-16: an entry after the cursor was trimmed',
      { cursor: pos(NOW - 5000, 0), maxDeletedId: pos(NOW - 4000, 0) },
      'resync',
    ],
    [
      'trimmed up to the cursor itself loses nothing',
      { cursor: pos(NOW - 5000, 0), maxDeletedId: pos(NOW - 5000, 0) },
      'replay',
    ],
    [
      'AS-17: cursor older than retention',
      { cursor: pos(NOW - HOUR - 1, 0) },
      'resync',
    ],
    [
      'AS-17: buffer expired entirely',
      { cursor: pos(NOW - 5000, 0), exists: false, latestId: '0-0' },
      'resync',
    ],
    [
      'AS-17: old cursor and buffer expired',
      { cursor: pos(NOW - 2 * HOUR, 0), exists: false, latestId: '0-0' },
      'resync',
    ],
  ])('%s', (_label, input, expected) => {
    expect(decideReplay({ ...base, ...input })).toBe(expected);
  });
});

describe('S51 AS-20 retention cutoff', () => {
  it.each([
    [NOW, HOUR, NOW - HOUR],
    [NOW, 1000, NOW - 1000],
    [500, HOUR, 0],
  ])('now %d age %d -> %d', (now, age, cutoff) => {
    expect(retentionCutoffMs(now, age)).toBe(cutoff);
  });
});

describe('S51 AS-51 retry jitter', () => {
  it.each([
    [0, 2000],
    [0.5, 3500],
    [0.999999, 5000],
    [0.25, 2750],
  ])('random %d -> %d ms', (random, expected) => {
    expect(retryDelayMs(random, 2000, 5000)).toBe(expected);
  });
});

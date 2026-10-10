import {
  formatBaseline,
  formatFrame,
  formatResync,
  formatRetry,
  formatRevoked,
  HEARTBEAT_FRAME,
} from './frame';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** Parses what a browser would: split on every line terminator the SSE spec knows (\r\n, \n, \r), frames on blank lines. */
const parse = (raw: string) =>
  raw
    .split(/\r\n|\n|\r/)
    .join('\n')
    .split('\n\n')
    .filter(Boolean)
    .map((block) =>
      Object.fromEntries(
        block.split('\n').map((line) => {
          const i = line.indexOf(': ');
          return [line.slice(0, i), line.slice(i + 2)];
        }),
      ),
    );

describe('S51 AS-06 frame serialization', () => {
  const hostile: [string, string][] = [
    ['a blank line', 'a\n\nevent: evil\ndata: {}'],
    ['a data: line', 'x\ndata: {"topic":"t","data":1}'],
    ['an id: line', 'x\nid: auction:a1~1-1'],
    ['a carriage return', 'x\revent: evil\rdata: 1'],
    ['U+2028 and U+2029', `x${LS}event: evil${PS}y`],
    ['30 KiB of text', 'z'.repeat(30 * 1024)],
    ['CRLF pairs', 'a\r\n\r\nb'],
  ];

  it.each(hostile)(
    'S51 AS-06: %s in a payload yields exactly one frame',
    (_label, text) => {
      const raw = formatFrame({
        cursor: 'auction:a1~5-1',
        type: 'price',
        topic: 'auction:a1',
        data: { text },
      })!;
      const frames = parse(raw);
      expect(frames).toHaveLength(1);
      expect(Object.keys(frames[0])).toEqual(['id', 'event', 'data']);
      expect(JSON.parse(frames[0].data)).toEqual({
        topic: 'auction:a1',
        data: { text },
      });
      expect(raw.endsWith('\n\n')).toBe(true);
      const body = raw.slice(0, -2);
      expect(body).not.toContain('\r');
      expect(body).not.toContain(LS);
      expect(body).not.toContain(PS);
      expect(body).not.toContain('\n\n');
    },
  );

  it('S51 AS-07: a live-only event has no id line', () => {
    const raw = formatFrame({ type: 'tick', topic: 'stream:s1', data: 1 })!;
    expect(raw).toBe('event: tick\ndata: {"topic":"stream:s1","data":1}\n\n');
  });

  it.each([
    ['a newline', 'price\nevent: evil'],
    ['a carriage return', 'price\r'],
    ['a colon-space', 'a: b'],
    ['empty', ''],
    ['a reserved name', 'resync'],
  ])('S51 AS-31: an event type with %s is never written', (_label, type) => {
    expect(formatFrame({ type, topic: 't:1', data: 1 })).toBeNull();
  });

  it('S51 AS-13: baseline, retry, resync, revoked and heartbeat frames', () => {
    expect(formatBaseline('auction:a2~9-1')).toBe('id: auction:a2~9-1\n\n');
    expect(formatRetry(3500)).toBe('retry: 3500\n\n');
    expect(formatResync('auction:a1')).toBe(
      'event: resync\ndata: {"topic":"auction:a1","data":{"reason":"replay-gap"}}\n\n',
    );
    expect(formatRevoked('shop:s1:live')).toBe(
      'event: revoked\ndata: {"topic":"shop:s1:live","data":{}}\n\n',
    );
    expect(HEARTBEAT_FRAME).toBe(': ping\n\n');
  });
});

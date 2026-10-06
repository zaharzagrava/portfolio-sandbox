import { describe, expect, it } from 'vitest';
import { SseParser } from './sse-reader';

describe('SseParser', () => {
  it('parses named events with ids and JSON data', () => {
    const events = new SseParser().feed('id: 1-0\nevent: text\ndata: {"t":"Hel"}\n\nevent: done\ndata: {}\n\n');
    expect(events).toEqual([
      { id: '1-0', event: 'text', data: '{"t":"Hel"}' },
      { id: undefined, event: 'done', data: '{}' },
    ]);
  });

  it('keeps partial chunks until the event is complete (split mid-line and mid-separator)', () => {
    const parser = new SseParser();
    expect(parser.feed('event: te')).toEqual([]);
    expect(parser.feed('xt\ndata: {"t":"a"}\n')).toEqual([]);
    expect(parser.feed('\nevent: done\r\ndata: {}\r\n\r\n')).toEqual([
      { id: undefined, event: 'text', data: '{"t":"a"}' },
      { id: undefined, event: 'done', data: '{}' },
    ]);
  });

  it('ignores comments/heartbeats and retry lines; defaults the event name; joins multi-line data', () => {
    const events = new SseParser().feed(': ping\n\nretry: 3000\n\ndata: line one\ndata: line two\n\n');
    expect(events).toEqual([{ id: undefined, event: 'message', data: 'line one\nline two' }]);
  });
});

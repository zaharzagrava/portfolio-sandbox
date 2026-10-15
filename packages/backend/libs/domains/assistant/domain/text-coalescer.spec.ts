import { TextCoalescer } from './text-coalescer';

const clock = { now: () => new Date(Date.now()), nowMs: () => Date.now() };

describe('S46 AS-10: text coalescing', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-15T10:00:00.000Z') }));
  afterEach(() => jest.useRealTimers());

  it('S46 AS-10: 400 one-character deltas within 200 ms give at most one event per 40 ms, order kept', () => {
    const events: { at: number; text: string }[] = [];
    const t0 = Date.now();
    const coalescer = new TextCoalescer((text) => events.push({ at: Date.now() - t0, text }), { clock });
    const expected: string[] = [];
    for (let ms = 0; ms < 200; ms++) {
      for (let k = 0; k < 2; k++) {
        const ch = String.fromCharCode(97 + ((ms * 2 + k) % 26));
        expected.push(ch);
        coalescer.push(ch);
      }
      jest.advanceTimersByTime(1);
    }
    coalescer.flush();
    expect(expected).toHaveLength(400);
    expect(events.map((e) => e.text).join('')).toBe(expected.join(''));
    expect(events.length).toBeLessThanOrEqual(Math.ceil(200 / 40) + 1);
    for (let i = 1; i < events.length - 1; i++) {
      expect(events[i].at - events[i - 1].at).toBeGreaterThanOrEqual(40);
    }
  });

  it('S46 AS-10: no event is longer than 256 characters; a bigger delta is split in order', () => {
    const events: string[] = [];
    const coalescer = new TextCoalescer((t) => events.push(t), { clock });
    const big = 'x'.repeat(600) + 'END';
    coalescer.push(big);
    coalescer.flush();
    expect(events.every((e) => e.length <= 256)).toBe(true);
    expect(events.join('')).toBe(big);
  });

  it('S46 AS-10: buffered characters reaching 256 are sent at once, without waiting for the timer', () => {
    const events: string[] = [];
    const coalescer = new TextCoalescer((t) => events.push(t), { clock });
    coalescer.push('a'); // leading edge
    for (let i = 0; i < 256; i++) coalescer.push('b');
    expect(events.join('')).toBe('a' + 'b'.repeat(256));
    expect(events.every((e) => e.length <= 256)).toBe(true);
  });

  it('S46 AS-10: a pending tail is sent by the timer 40 ms after the last event', () => {
    const events: string[] = [];
    const coalescer = new TextCoalescer((t) => events.push(t), { clock });
    coalescer.push('a');
    coalescer.push('b');
    expect(events).toEqual(['a']);
    jest.advanceTimersByTime(39);
    expect(events).toEqual(['a']);
    jest.advanceTimersByTime(1);
    expect(events).toEqual(['a', 'b']);
  });

  it('S46 AS-10: flush sends what is pending first, and nothing is emitted after it (no text after the terminal event)', () => {
    const events: string[] = [];
    const coalescer = new TextCoalescer((t) => events.push(t), { clock });
    coalescer.push('a');
    coalescer.push('tail');
    coalescer.flush();
    expect(events).toEqual(['a', 'tail']);
    coalescer.push('late');
    coalescer.flush();
    jest.advanceTimersByTime(1000);
    expect(events).toEqual(['a', 'tail']);
  });

  it('S46 AS-10: flush with nothing pending emits nothing; empty deltas are ignored', () => {
    const events: string[] = [];
    const coalescer = new TextCoalescer((t) => events.push(t), { clock });
    coalescer.push('');
    coalescer.flush();
    expect(events).toEqual([]);
  });

  it('S46 AS-10: discard drops pending text without emitting (refusal path)', () => {
    const events: string[] = [];
    const coalescer = new TextCoalescer((t) => events.push(t), { clock });
    coalescer.push('a');
    coalescer.push('secret');
    coalescer.discard();
    jest.advanceTimersByTime(1000);
    expect(events).toEqual(['a']);
  });
});

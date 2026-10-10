import { commitFloor } from './commit-floor';
import { PartitionWindows, windowStartOf } from './tumbling-windows';

const MIN = 60_000;
const cfg = {
  windowMs: MIN,
  latenessMs: 2 * MIN,
  idleMs: 30_000,
  horizonMs: 60 * MIN,
};
const at = (hhmmss: string) => Date.parse(`2026-10-10T${hhmmss}Z`);
const make = () => new PartitionWindows<{ n: number }>(cfg, () => ({ n: 0 }));

/** Feeds one event the way the ingest service does: classify against the watermark so far, then observe, then count. */
function feed(
  w: PartitionWindows<{ n: number }>,
  eventTime: string,
  opts: { receivedAt?: string; now?: string; offset?: number } = {},
) {
  const eventTimeMs = at(eventTime);
  const receivedAtMs = at(opts.receivedAt ?? eventTime);
  const nowMs = at(opts.now ?? opts.receivedAt ?? eventTime);
  const classification = w.classify(eventTimeMs, nowMs);
  w.observe({ eventTimeMs, receivedAtMs, nowMs });
  if (classification === 'open')
    w.open(eventTimeMs, opts.offset ?? 0).state.n++;
  return classification;
}

describe('S35 tumbling windows by event time (U3)', () => {
  it.each([
    ['12:00:00', '12:00:00'],
    ['12:00:30', '12:00:00'],
    ['12:00:59.999', '12:00:00'],
    ['12:01:00', '12:01:00'],
    ['23:59:59', '23:59:00'],
  ])('S35 AS-17: %s belongs to the window starting %s', (time, start) => {
    expect(windowStartOf(at(time), MIN)).toBe(at(start));
  });

  it('S35 AS-17: out-of-order events land in their own window and a window closes only when the watermark reaches its end', () => {
    const w = make();
    expect(feed(w, '12:00:30')).toBe('open');
    expect(feed(w, '12:00:10')).toBe('open'); // out of order, same window
    expect(feed(w, '12:01:59')).toBe('open');
    expect(w.watermark()).toBe(at('11:59:59'));
    expect(w.closeReady()).toEqual([]); // nothing visible yet
    expect(feed(w, '12:03:00')).toBe('open');
    expect(w.watermark()).toBe(at('12:01:00'));
    const closed = w.closeReady();
    expect(closed.map((c) => c.start)).toEqual([at('12:00:00')]);
    expect(closed[0].state.n).toBe(2); // both events, whichever order they arrived
  });

  it('S35 AS-17: windows close in start order and only past the watermark (dataset T)', () => {
    const w = make();
    for (const t of ['12:00:30', '12:01:30', '12:02:30', '12:03:30'])
      feed(w, t);
    // newest event 12:03:30 → watermark 12:01:30: only [12:00, 12:01) has ended
    expect(w.closeReady().map((c) => c.start)).toEqual([at('12:00:00')]);
    feed(w, '12:06:00'); // watermark 12:04:00
    expect(w.closeReady().map((c) => c.start)).toEqual([
      at('12:00:00'),
      at('12:01:00'),
      at('12:02:00'),
      at('12:03:00'),
    ]);
  });

  it('S35 AS-17: arrival time never closes a window - only the watermark does', () => {
    const w = make();
    feed(w, '12:00:30', { now: '12:00:30' });
    // an hour later by the wall clock, but the partition is busy (a message 10 s ago) and event time did not move
    feed(w, '12:00:31', { now: '12:59:50' });
    w.tick(at('13:00:00'));
    expect(w.watermark()).toBeLessThan(at('12:01:00'));
    expect(w.closeReady()).toEqual([]);
  });

  it('S35 AS-20: a forged future ts cannot move the watermark past the newest received_at minus the lateness', () => {
    const w = make();
    feed(w, '12:00:00', { receivedAt: '12:00:00' });
    // normalisation already clamps the event time; the partition defends itself as well
    w.observe({
      eventTimeMs: at('13:30:00'),
      receivedAtMs: at('12:00:05'),
      nowMs: at('12:00:05'),
    });
    expect(w.watermark()).toBeLessThanOrEqual(at('12:00:05') - cfg.latenessMs);
    expect(w.closeReady()).toEqual([]);
    expect(feed(w, '12:00:10', { receivedAt: '12:00:10' })).toBe('open');
  });

  it('S35 AS-19: classification - open, closed inside the horizon, closed beyond it', () => {
    const w = make();
    // watermark 12:09:59: the window [12:09, 12:10) is still open
    feed(w, '12:11:59', { now: '12:12:00' });
    expect(w.watermark()).toBe(at('12:09:59'));
    expect(w.classify(at('12:09:30'), at('12:12:00'))).toBe('open');
    expect(w.classify(at('12:05:30'), at('12:12:00'))).toBe('late_corrected');
    expect(w.classify(at('11:30:00'), at('12:12:00'))).toBe('late_corrected');
    expect(w.classify(at('10:50:00'), at('12:12:00'))).toBe('late_dropped');
  });

  it('S35 AS-19: the horizon is the 60 windows ending at the latest boundary, edge included', () => {
    const w = make();
    feed(w, '14:00:00', { now: '14:00:00' }); // watermark 13:58:00
    // now 14:00:30: boundary 14:00:00, horizon start 13:00:00
    expect(w.classify(at('13:00:00'), at('14:00:30'))).toBe('late_corrected');
    expect(w.classify(at('12:59:59'), at('14:00:30'))).toBe('late_dropped');
  });

  it('S35 AS-19: a closed window never reopens', () => {
    const w = make();
    feed(w, '12:00:30');
    feed(w, '12:05:00');
    expect(w.closeReady().length).toBe(1);
    expect(w.classify(at('12:00:45'), at('12:05:00'))).toBe('late_corrected');
    expect(() => w.open(at('12:00:45'), 9)).toThrow();
  });

  it('S35 AS-21: an idle partition advances by the wall clock to now minus the lateness', () => {
    const w = make();
    feed(w, '12:00:15', { receivedAt: '12:00:20', now: '12:00:20' });
    w.tick(at('12:00:49')); // idle for 29 s: not idle yet
    expect(w.watermark()).toBe(at('11:58:15'));
    w.tick(at('12:03:20'));
    expect(w.watermark()).toBe(at('12:01:20'));
    expect(w.closeReady().map((c) => c.start)).toEqual([at('12:00:00')]);
  });

  it('S35 AS-21: a partition that keeps receiving messages is never advanced by the clock', () => {
    const w = make();
    feed(w, '12:00:15', { now: '12:00:20' });
    feed(w, '12:00:16', { now: '12:03:10' }); // a message arrived 10 s before the tick
    w.tick(at('12:03:20'));
    expect(w.watermark()).toBe(at('11:58:16'));
    expect(w.closeReady()).toEqual([]);
  });

  it('S35 AS-21: a partition that never received a message is not advanced', () => {
    const w = make();
    w.tick(at('13:00:00'));
    expect(w.watermark()).toBe(Number.NEGATIVE_INFINITY);
  });

  it('S35 AS-21: the idle watermark never moves backwards', () => {
    const w = make();
    feed(w, '12:00:15', { now: '12:00:20' });
    w.tick(at('12:03:20'));
    w.tick(at('12:03:00')); // clock reading earlier (tests, skew)
    expect(w.watermark()).toBe(at('12:01:20'));
  });

  it('S35 AS-31: a merged window leaves the unmerged set; a failed one stays and is offered again', () => {
    const w = make();
    feed(w, '12:00:30', { offset: 10 });
    feed(w, '12:05:00', { offset: 11 });
    const [first] = w.closeReady();
    expect(first.firstOffset).toBe(10);
    // merge failed: nothing marked; the next tick offers it again
    expect(w.closeReady().map((c) => c.start)).toEqual([first.start]);
    w.markMerged(first.start);
    expect(w.closeReady()).toEqual([]);
  });

  it('S35 AS-34: closeAll force-closes every open window for a graceful shutdown', () => {
    const w = make();
    feed(w, '12:00:30');
    feed(w, '12:01:30');
    expect(w.closeAll().map((c) => c.start)).toEqual([
      at('12:00:00'),
      at('12:01:00'),
    ]);
  });

  it('S35 AS-32: offsets of a window span the events counted into it', () => {
    const w = make();
    feed(w, '12:00:10', { offset: 7 });
    feed(w, '12:00:50', { offset: 5 });
    feed(w, '12:00:20', { offset: 9 });
    const [entry] = w.closeAll();
    expect([entry.firstOffset, entry.lastOffset]).toEqual([5, 9]);
  });
});

describe('S35 commit floor (U3, R-2)', () => {
  it.each([
    ['no unmerged work: last consumed + 1', 99, [], 100],
    ['one unmerged window: its first offset', 99, [40], 40],
    ['the earliest of several', 99, [60, 40, 80], 40],
    ['nothing consumed yet and nothing pending', null, [], null],
    [
      'pending work holds the floor even when nothing is consumed since',
      10,
      [3],
      3,
    ],
  ])('S35 AS-32: %s', (_name, lastConsumed, pending, expected) => {
    expect(commitFloor(lastConsumed, pending)).toBe(expected);
  });

  it('S35 AS-32: the floor is per partition and open windows, merge-failed windows and correction buffers all count', () => {
    const w = make();
    feed(w, '12:00:30', { offset: 10 });
    feed(w, '12:01:30', { offset: 20 });
    feed(w, '12:06:00', { offset: 30 }); // closes the first two
    const closed = w.closeReady();
    w.markMerged(closed[1].start); // second merged, first merge failed
    const pending = [...w.firstOffsets(), 15]; // 15: a correction buffer
    expect(commitFloor(30, pending)).toBe(10);
    w.markMerged(closed[0].start);
    expect(commitFloor(30, [...w.firstOffsets()])).toBe(30); // only the open [12:06) window
  });
});

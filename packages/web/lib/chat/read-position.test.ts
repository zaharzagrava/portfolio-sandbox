import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadTracker, type ReadTracker } from './read-position';

const rateLimited = (retryAfter?: string) => ({ response: { status: 429, data: { code: 'rate_limited' }, headers: retryAfter ? { 'retry-after': retryAfter } : {} } });
const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

function setup(markRead = vi.fn(async (seq: number) => ({ lastReadSeq: seq, unread: 0 }))) {
  const onResult = vi.fn();
  const tracker: ReadTracker = createReadTracker({ markRead, onResult });
  return { tracker, markRead, onResult };
}

describe('Read position', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('W05 AS-31 UC10: a position seen while the tab is visible and focused is sent once, after the 500 ms debounce', async () => {
    const { tracker, markRead } = setup();
    tracker.setActive(true);
    tracker.report(5);
    await vi.advanceTimersByTimeAsync(499);
    expect(markRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(markRead).toHaveBeenCalledExactlyOnceWith(5);
  });

  it('W05 AS-31 UC10: nothing is sent while the tab is hidden or unfocused; going active sends the highest position seen meanwhile', async () => {
    const { tracker, markRead } = setup();
    tracker.report(3);
    tracker.report(8);
    await vi.advanceTimersByTimeAsync(5000);
    expect(markRead).not.toHaveBeenCalled();
    tracker.setActive(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(markRead).toHaveBeenCalledExactlyOnceWith(8);
    tracker.setActive(false);
    tracker.report(9);
    await vi.advanceTimersByTimeAsync(5000);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-31 UC10: reports within the debounce window collapse to one call with the highest position', async () => {
    const { tracker, markRead } = setup();
    tracker.setActive(true);
    tracker.report(2);
    await vi.advanceTimersByTimeAsync(300);
    tracker.report(4);
    await vi.advanceTimersByTimeAsync(300);
    tracker.report(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(markRead).toHaveBeenCalledExactlyOnceWith(4);
  });

  it('W05 AS-31 UC10: a position already acknowledged, or lower, is never sent again', async () => {
    const { tracker, markRead } = setup();
    tracker.setActive(true);
    tracker.report(6);
    await vi.advanceTimersByTimeAsync(500);
    tracker.report(6);
    tracker.report(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(markRead).toHaveBeenCalledTimes(1);
    tracker.report(7);
    await vi.advanceTimersByTimeAsync(500);
    expect(markRead.mock.calls).toEqual([[6], [7]]);
  });

  it('W05 AS-31 UC10: the unread number comes from the response (the server\'s value), and the acknowledged position from lastReadSeq', async () => {
    const markRead = vi.fn(async () => ({ lastReadSeq: 9, unread: 2 }));
    const { tracker, onResult } = setup(markRead);
    tracker.setActive(true);
    tracker.report(6);
    await vi.advanceTimersByTimeAsync(500);
    expect(onResult).toHaveBeenCalledWith({ lastReadSeq: 9, unread: 2 });
    tracker.report(8); // the server already holds 9 (another tab): nothing to send
    await vi.advanceTimersByTimeAsync(1000);
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('W05 AS-31 UC10: a position that grows while a call is in flight is sent after it, once', async () => {
    let release!: () => void;
    const markRead = vi.fn((seq: number) => new Promise<{ lastReadSeq: number; unread: number }>((resolve) => (release = () => resolve({ lastReadSeq: seq, unread: 0 }))));
    const { tracker } = setup(markRead);
    tracker.setActive(true);
    tracker.report(3);
    await vi.advanceTimersByTimeAsync(500);
    tracker.report(5);
    await vi.advanceTimersByTimeAsync(500);
    expect(markRead).toHaveBeenCalledTimes(1);
    release();
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(markRead.mock.calls).toEqual([[3], [5]]);
  });

  it('W05 AS-36 UC10: a 429 waits for Retry-After, then sends one call with the highest position seen meanwhile; nothing is shown', async () => {
    const markRead = vi.fn<(seq: number) => Promise<{ lastReadSeq: number; unread: number }>>().mockRejectedValueOnce(rateLimited('20')).mockImplementation(async (seq) => ({ lastReadSeq: seq, unread: 0 }));
    const { tracker, onResult } = setup(markRead);
    tracker.setActive(true);
    tracker.report(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(markRead).toHaveBeenCalledTimes(1);
    tracker.report(6);
    tracker.report(9);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(markRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(markRead.mock.calls).toEqual([[3], [9]]);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ lastReadSeq: 9, unread: 0 });
  });

  it('W05 AS-36 UC10: a 429 without Retry-After waits 10 seconds', async () => {
    const markRead = vi.fn<(seq: number) => Promise<{ lastReadSeq: number; unread: number }>>().mockRejectedValueOnce(rateLimited()).mockImplementation(async (seq) => ({ lastReadSeq: seq, unread: 0 }));
    const { tracker } = setup(markRead);
    tracker.setActive(true);
    tracker.report(4);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(markRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(markRead).toHaveBeenCalledTimes(2);
  });

  it('W05 AS-36 UC10: any other failure is silent and does not loop; the next report tries again', async () => {
    const markRead = vi.fn<(seq: number) => Promise<{ lastReadSeq: number; unread: number }>>().mockRejectedValueOnce(new Error('network')).mockImplementation(async (seq) => ({ lastReadSeq: seq, unread: 0 }));
    const { tracker } = setup(markRead);
    tracker.setActive(true);
    tracker.report(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(markRead).toHaveBeenCalledTimes(1);
    tracker.report(5);
    await vi.advanceTimersByTimeAsync(500);
    expect(markRead.mock.calls).toEqual([[4], [5]]);
  });

  it('W05 AS-31 UC10: dispose cancels a pending call', async () => {
    const { tracker, markRead } = setup();
    tracker.setActive(true);
    tracker.report(4);
    tracker.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('W05 AS-31 UC10: a start position (the server\'s lastReadSeq when the chat opens) is already acknowledged', async () => {
    const onResult = vi.fn();
    const markRead = vi.fn(async (seq: number) => ({ lastReadSeq: seq, unread: 0 }));
    const tracker = createReadTracker({ markRead, onResult, acknowledged: 7 });
    tracker.setActive(true);
    tracker.report(7);
    tracker.report(5);
    await vi.advanceTimersByTimeAsync(2000);
    expect(markRead).not.toHaveBeenCalled();
    tracker.report(8);
    await vi.advanceTimersByTimeAsync(500);
    expect(markRead).toHaveBeenCalledExactlyOnceWith(8);
  });
});

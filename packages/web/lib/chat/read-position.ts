import { problemFromError } from '@/lib/api/errors';

/**
 * When a message counts as read (W05 FR-046, AS-31, AS-36). The component reports the highest `seq` that is rendered in the
 * visible part of the list; the tracker sends it only while the tab is visible and focused, after a 500 ms debounce, never
 * repeats a position that was acknowledged and never goes lower. A `429` waits for `Retry-After` (10 s when absent) and then
 * sends one call with the highest position seen meanwhile. Failures are silent: reading is best effort.
 */

export const READ_DEBOUNCE_MS = 500;
export const READ_DEFAULT_RETRY_AFTER_MS = 10_000;

export type MarkReadResult = { lastReadSeq: number; unread: number };

export type ReadTracker = {
  /** The highest `seq` currently seen in the visible area of the list. */
  report: (seq: number) => void;
  /** Whether the tab is visible and focused (the component re-reports the visible position when it becomes active). */
  setActive: (active: boolean) => void;
  /** Cancels timers; nothing is sent afterwards. */
  dispose: () => void;
};

export function createReadTracker(options: {
  markRead: (seq: number) => Promise<MarkReadResult>;
  /** Called with every successful answer: the inbox badge is set from `unread`, never guessed. */
  onResult: (result: MarkReadResult) => void;
  /** The `lastReadSeq` the server already holds when the chat opens. */
  acknowledged?: number;
}): ReadTracker {
  let acknowledged = options.acknowledged ?? 0;
  let target = 0;
  let active = false;
  let inFlight = false;
  let blockedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(fire, delay);
  };

  function fire() {
    timer = undefined;
    if (disposed || !active || inFlight || target <= acknowledged) return;
    const wait = blockedUntil - Date.now();
    if (wait > 0) return schedule(wait);
    inFlight = true;
    const sending = target;
    options
      .markRead(sending)
      .then(
        (result) => {
          acknowledged = Math.max(acknowledged, result.lastReadSeq, sending);
          if (!disposed) options.onResult(result);
        },
        (error: unknown) => {
          const problem = problemFromError(error);
          if (problem.status === 429) blockedUntil = Date.now() + (problem.retryAfterSeconds !== undefined ? problem.retryAfterSeconds * 1000 : READ_DEFAULT_RETRY_AFTER_MS);
        },
      )
      .finally(() => {
        inFlight = false;
        if (disposed || !active || target <= acknowledged) return;
        // A position that grew meanwhile, or a rate-limit wait: one more call, for the highest position then.
        const wait = Math.max(blockedUntil - Date.now(), 0);
        if (wait > 0 || target > sending) schedule(wait > 0 ? wait : READ_DEBOUNCE_MS);
      });
  }

  return {
    report(seq) {
      if (disposed || seq <= acknowledged) return;
      target = Math.max(target, seq);
      if (active && !inFlight) schedule(READ_DEBOUNCE_MS);
    },
    setActive(next) {
      if (disposed) return;
      active = next;
      if (!next) {
        clearTimeout(timer);
        timer = undefined;
      } else if (target > acknowledged && !inFlight) schedule(READ_DEBOUNCE_MS);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

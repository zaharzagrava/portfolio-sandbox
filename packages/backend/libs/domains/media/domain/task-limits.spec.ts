import {
  backoffSec,
  HEARTBEAT_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_VIDEO_RETRIES,
  nextAfterFailure,
  PROCESSING_LIMIT_MS,
  SQS_VISIBILITY_SEC,
  STUCK_RESEND_GUARD_MS,
  taskTimeoutMs,
} from './task-limits';

const S = 1000;
const H = 3600 * S;

describe('task time limits and backoff', () => {
  it('S30 AS-24: three attempts per task', () => {
    expect(MAX_ATTEMPTS).toBe(3);
    expect(MAX_VIDEO_RETRIES).toBe(3);
  });

  describe('backoff', () => {
    it.each([
      [1, 30],
      [2, 120],
    ])(
      'S30 AS-24: after failed attempt %i the next message is delayed %i s',
      (attempt, delay) => {
        expect(backoffSec(attempt)).toBe(delay);
      },
    );

    it.each([3, 4, 10])(
      'S30 AS-24: after attempt %i there is no retry',
      (attempt) => {
        expect(backoffSec(attempt)).toBeNull();
      },
    );

    it.each([0, -1, 1.5, Number.NaN])(
      'S30 AS-24: attempt %f is not a valid attempt number',
      (attempt) => {
        expect(() => backoffSec(attempt)).toThrow(RangeError);
      },
    );

    it('S30 AS-24: every delay fits the queue limit of 900 s', () => {
      for (let a = 1; a < MAX_ATTEMPTS; a++)
        expect(backoffSec(a)!).toBeLessThanOrEqual(900);
    });
  });

  describe('time limit per task', () => {
    // [task, durationSec, expected ms]
    const table: [string, number, number][] = [
      ['transcode:720', 10, 600 * S],
      ['transcode:720', 100, 600 * S],
      ['transcode:720', 200, 600 * S], // 3 x 200 = 600: boundary
      ['transcode:720', 201, 603 * S],
      ['transcode:1080', 1800, 5400 * S],
      ['transcode:240', 3600, 10_800 * S], // 3 h exactly
      ['transcode:240', 7200, 3 * H], // 6 h of work is capped at 3 h
      ['transcode:240', 100_000, 3 * H],
      ['probe', 6, 60 * S],
      ['probe', 7200, 60 * S],
      ['poster', 6, 120 * S],
      ['poster', 7200, 120 * S],
      ['thumbnails', 6, 120 * S],
      ['thumbnails', 7200, 120 * S],
      ['package', 6, 60 * S],
      ['package', 7200, 60 * S],
      ['publish', 6, 60 * S],
    ];

    it.each(table)(
      'S30 AS-25: %s of a %f s video -> %i ms',
      (task, dur, ms) => {
        expect(taskTimeoutMs(task, dur)).toBe(ms);
      },
    );

    it('S30 AS-25: an unknown task has no limit and is refused', () => {
      expect(() => taskTimeoutMs('transcode:', 10)).toThrow();
      expect(() => taskTimeoutMs('ls; rm', 10)).toThrow();
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
      'S30 AS-25: a bad duration (%f) falls back to the floor for transcode',
      (d) => {
        expect(taskTimeoutMs('transcode:480', d)).toBe(600 * S);
      },
    );
  });

  describe('constants', () => {
    it('S30 AS-23: lease 5 minutes, heartbeat 60 s, visibility 900 s', () => {
      expect(LEASE_MS).toBe(5 * 60 * S);
      expect(HEARTBEAT_MS).toBe(60 * S);
      expect(SQS_VISIBILITY_SEC).toBe(900);
      expect(HEARTBEAT_MS).toBeLessThan(LEASE_MS);
    });

    it('S30 AS-51: a video may stay in PROCESSING for 6 h; the resend guard is 1 min', () => {
      expect(PROCESSING_LIMIT_MS).toBe(6 * H);
      expect(STUCK_RESEND_GUARD_MS).toBe(60 * S);
    });
  });

  describe('decision after a failed attempt', () => {
    const transient = { kind: 'transient' } as const;

    it.each([1, 2])(
      'S30 AS-24: a transient failure on attempt %i re-queues with backoff',
      (attempt) => {
        expect(
          nextAfterFailure({ failure: transient, attempt, optional: false }),
        ).toEqual({ action: 'retry', delaySec: backoffSec(attempt) });
      },
    );

    it.each([
      ['transient', 'transcode_failed'],
      ['storage', 'storage_unavailable'],
      ['timeout', 'task_timeout'],
    ] as const)(
      'S30 AS-24: a %s failure on the last attempt fails the video with %s',
      (kind, code) => {
        expect(
          nextAfterFailure({ failure: { kind }, attempt: 3, optional: false }),
        ).toEqual({ action: 'fail', failureCode: code });
      },
    );

    it('S30 AS-25: a timeout is retried before the last attempt', () => {
      expect(
        nextAfterFailure({
          failure: { kind: 'timeout' },
          attempt: 1,
          optional: false,
        }),
      ).toEqual({ action: 'retry', delaySec: 30 });
    });

    it.each([1, 2, 3])(
      'S30 AS-21: a permanent failure on attempt %i fails at once with its own code',
      (attempt) => {
        expect(
          nextAfterFailure({
            failure: { kind: 'permanent', code: 'not_a_video' },
            attempt,
            optional: false,
          }),
        ).toEqual({ action: 'fail', failureCode: 'not_a_video' });
      },
    );

    it('S30 AS-28: an optional task gives up on its last attempt instead of failing the video', () => {
      expect(
        nextAfterFailure({ failure: transient, attempt: 3, optional: true }),
      ).toEqual({ action: 'skip' });
      expect(
        nextAfterFailure({ failure: transient, attempt: 1, optional: true }),
      ).toEqual({ action: 'retry', delaySec: 30 });
    });

    it.each([1, 2, 3])(
      'S30 AS-62: a shutdown on attempt %i re-queues without delay and without an attempt',
      (attempt) => {
        expect(
          nextAfterFailure({
            failure: { kind: 'shutdown' },
            attempt,
            optional: false,
          }),
        ).toEqual({ action: 'requeue' });
      },
    );
  });
});

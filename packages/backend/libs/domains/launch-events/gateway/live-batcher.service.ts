import type { Clock } from '@app/common/core/clock';
import { liveMetrics } from '../application/live-metrics';
import type { LiveComment } from '../domain/live-constants';
import type { LiveSettings, LiveTimers } from '../domain/live-ports';
import { Reservoir } from '../domain/reservoir';
import { composeWindow } from '../domain/window-composer';

export interface LiveViewer {
  userId?: string;
  send(event: string, data: unknown): void;
  /** Ends the connection (after what was already written). */
  close(reason: 'ended' | 'shutdown' | 'slow'): void;
}

/**
 * One per (gateway instance, live stream) - the "regional fan-out" tier of 10/06 #15. The instance subscribes ONCE to
 * the stream's comment feed however many of its viewers watch, closes a window every `windowMs`, reduces the ordinary
 * comments to `sampleSize` fair picks with a reservoir, and writes ONE batched event per viewer per window: priority
 * comments (shop staff, never capped) + the viewer's OWN comments + the sample. Fan-out work is viewers × windows,
 * independent of the comment rate. Low-rate control events (pin, removals, stats, status) pass straight through.
 */
export class StreamBatcher {
  readonly viewers = new Set<LiveViewer>();
  private readonly reservoir: Reservoir<LiveComment>;
  private priority: LiveComment[] = [];
  private own = new Map<string, LiveComment[]>();
  private readonly watchingUsers = new Map<string, number>();
  private readonly stopTimer: () => void;
  /** Comments received over the instance's lifetime for this stream (specs wait on it). */
  received = 0;

  constructor(
    readonly streamId: string,
    private readonly settings: LiveSettings,
    timers: LiveTimers,
    private readonly clock: Clock,
  ) {
    this.reservoir = new Reservoir<LiveComment>(settings.sampleSize);
    this.stopTimer = timers.every(settings.windowMs, () => this.tick());
  }

  add(viewer: LiveViewer) {
    this.viewers.add(viewer);
    if (viewer.userId)
      this.watchingUsers.set(
        viewer.userId,
        (this.watchingUsers.get(viewer.userId) ?? 0) + 1,
      );
  }

  remove(viewer: LiveViewer) {
    this.viewers.delete(viewer);
    if (viewer.userId) {
      const left = (this.watchingUsers.get(viewer.userId) ?? 1) - 1;
      if (left <= 0) this.watchingUsers.delete(viewer.userId);
      else this.watchingUsers.set(viewer.userId, left);
    }
  }

  onComment(comment: LiveComment) {
    this.received++;
    if (comment.priority) this.priority.push(comment);
    else this.reservoir.offer(comment);
    if (this.watchingUsers.has(comment.authorId))
      this.own.set(comment.authorId, [
        ...(this.own.get(comment.authorId) ?? []),
        comment,
      ]);
  }

  /** Control event: straight to every viewer, unsampled (FR-012). */
  broadcast(event: string, data: unknown) {
    for (const viewer of [...this.viewers]) viewer.send(event, data);
    if (
      event === 'status' &&
      (data as { status?: string } | null)?.status === 'ENDED'
    )
      for (const viewer of [...this.viewers]) viewer.close('ended');
  }

  /** Closes the window: one `comments` event per viewer, or nothing when the window was empty. */
  tick() {
    const { sample, seen } = this.reservoir.drain();
    const priority = this.priority;
    const own = this.own;
    this.priority = [];
    this.own = new Map();
    liveMetrics.windowComments.set(seen + priority.length);
    if (sample.length === 0 && priority.length === 0 && own.size === 0) return;

    const shared = composeWindow({ priority, sample });
    const rate = Math.round(
      (seen + priority.length) * (1000 / this.settings.windowMs),
    );
    const now = this.clock.nowMs();
    for (const comment of shared)
      liveMetrics.deliveryLag.record(Math.max(0, now - comment.at) / 1000);
    liveMetrics.batchItems.set(shared.length);
    for (const viewer of [...this.viewers]) {
      const mine = viewer.userId ? (own.get(viewer.userId) ?? []) : [];
      viewer.send('comments', {
        items: mine.length
          ? composeWindow({ priority, sample, own: mine })
          : shared,
        rate,
      });
    }
  }

  stop() {
    this.stopTimer();
  }
}

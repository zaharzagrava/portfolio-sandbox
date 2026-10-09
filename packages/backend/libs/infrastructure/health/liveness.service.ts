import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '@app/common/core/clock';
import type { Clock } from '@app/common/core/clock';
import { EventLoopMonitor } from '@app/common/load-shedding/event-loop-monitor.service';

/** Returns the current event-loop lag in ms; a provider so tests inject a value. */
export const EVENT_LOOP_LAG_SAMPLER = Symbol('EVENT_LOOP_LAG_SAMPLER');
export type EventLoopLagSampler = () => number;

/** Beyond this lag the process is wedged, not busy: restarting helps (shedding handles the busy range). */
export const EXTREME_EVENT_LOOP_LAG_MS = 10_000;

export const eventLoopLagSamplerProvider = {
  provide: EVENT_LOOP_LAG_SAMPLER,
  // The one shared monitor (LoadSheddingModule): a second sampler per consumer would keep its own histogram and timer alive.
  inject: [EventLoopMonitor],
  useFactory:
    (monitor: EventLoopMonitor): EventLoopLagSampler =>
    () =>
      monitor.p99Ms(),
};

/**
 * In-process "can this process make progress?" (S54 FR-031). Never touches a store: it fails only on an extreme
 * event-loop lag or on a registered heartbeat that went silent, so a Postgres outage never restarts the fleet.
 */
@Injectable()
export class LivenessService {
  private readonly heartbeats = new Map<
    string,
    { maxSilenceMs: number; lastBeatAt: number }
  >();

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EVENT_LOOP_LAG_SAMPLER)
    private readonly sampleLag: EventLoopLagSampler,
  ) {}

  registerHeartbeat(name: string, maxSilenceMs: number): void {
    this.heartbeats.set(name, {
      maxSilenceMs,
      lastBeatAt: this.clock.now().getTime(),
    });
  }

  /** Call when the consumer stops on purpose, so its silence is not read as a hang. */
  unregisterHeartbeat(name: string): void {
    this.heartbeats.delete(name);
  }

  beat(name: string): void {
    const hb = this.heartbeats.get(name);
    if (hb) hb.lastBeatAt = this.clock.now().getTime();
  }

  /** Names only, never messages. */
  report(): { alive: boolean; failing: string[] } {
    const failing: string[] = [];
    if (this.sampleLag() > EXTREME_EVENT_LOOP_LAG_MS)
      failing.push('event-loop');
    const now = this.clock.now().getTime();
    for (const [name, hb] of this.heartbeats)
      if (now - hb.lastBeatAt > hb.maxSilenceMs) failing.push(name);
    return { alive: failing.length === 0, failing };
  }
}

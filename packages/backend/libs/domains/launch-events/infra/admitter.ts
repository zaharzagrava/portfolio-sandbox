import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { DistributedLock } from '@app/infrastructure/cache';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { EventGateService } from '../application/event-gate.service';
import { LaunchEventService } from '../application/launch-event.service';
import {
  ADMISSION_TOKEN_PORT,
  QUEUE_STORE,
  type AdmissionTokenPort,
  type AdmittedItem,
  type GateRecord,
  type QueueStore,
} from '../domain/ports';
import { fullBucket, takeFromBucket } from '../domain/token-bucket';
import { launchMetrics } from '../launch-metrics';

export const LAUNCH_ADMITTER_OPTIONS = Symbol('LAUNCH_ADMITTER_OPTIONS');
export interface AdmitterOptions {
  /** Start the one-second timer at application start (specs turn it off and call `tick()` with the injected clock). */
  autoStart: boolean;
}

const TICK_MS = 1_000;
const LEASE_MS = 5_000;
/** Tickets taken per peek/commit round, so a very high admission rate does not build one huge script call. */
const BATCH = 1_000;

/**
 * Admits `admissionRatePerSec` buyers per second per event (P0619, P0326). Runs in every worker; per event only the
 * holder of the `DistributedLock` lease acts, and every admission script call carries the lock's fence as the epoch: a
 * paused admitter whose lease lapsed finds a newer epoch and is refused (`launch_admission_stale_leader_total`). The
 * bucket (pure `token-bucket.ts`) holds one second of the rate, so downtime never turns into a burst.
 */
@Injectable()
export class Admitter implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(Admitter.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    @Inject(QUEUE_STORE) private readonly queue: QueueStore,
    @Inject(ADMISSION_TOKEN_PORT) private readonly tokens: AdmissionTokenPort,
    @Inject(LAUNCH_ADMITTER_OPTIONS) private readonly options: AdmitterOptions,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly locks: DistributedLock,
    private readonly gates: EventGateService,
    private readonly events: LaunchEventService,
    private readonly realtime: RealtimePublisher,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    // Stops first on shutdown, before the stores it writes to go away.
    shutdown?.register({
      name: 'launch-events.admitter.stop',
      order: 10,
      run: () => {
        clearInterval(this.timer);
        return Promise.resolve();
      },
    });
  }

  onApplicationBootstrap() {
    if (!this.options.autoStart) return;
    this.timer = setInterval(
      () => void this.tick().catch((e) => this.logger.warn(`tick: ${e?.name}`)),
      TICK_MS,
    );
    this.timer.unref();
  }

  /** A closed application must not keep admitting: the shutdown registry only runs on a real signal, not on `app.close()`. */
  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** One pass over every event with a waiting room. Returns the admitted count per event. */
  async tick(): Promise<Record<string, number>> {
    if (this.ticking) return {};
    this.ticking = true;
    const admitted: Record<string, number> = {};
    try {
      for (const eventId of await this.queue.activeEvents()) {
        try {
          admitted[eventId] = await this.admitEvent(eventId);
        } catch (error) {
          this.logger.warn(`admit failed: ${(error as Error)?.name}`);
        }
      }
    } finally {
      this.ticking = false;
    }
    return admitted;
  }

  /** Takes the event's lease and admits for one second. `0` when another admitter holds the lease. */
  async admitEvent(eventId: string): Promise<number> {
    let gate = await this.gates.require(eventId).catch(() => null);
    if (!gate) {
      await this.queue.retire(eventId);
      return 0;
    }
    const nowMs = this.clock.nowMs();
    if (gate.status === 'SCHEDULED' && nowMs >= gate.salesOpenAtMs) {
      // The open-sales job is late: the same conditional update, so it happens once (AS-55).
      await this.events.openSales(eventId);
      gate = await this.gates.require(eventId);
    }
    if (gate.status !== 'ON_SALE' || nowMs < gate.salesOpenAtMs) return 0;

    const lock = await this.locks.tryAcquire(`launch-admit:${eventId}`, {
      ttlMs: LEASE_MS,
    });
    if (!lock) return 0;
    try {
      return await this.admitWithFence(gate, lock.fence);
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  /** The guarded part: public so a specification can play a paused admitter that resumes with an old fence. */
  async admitWithFence(gate: GateRecord, fence: number): Promise<number> {
    const { eventId } = gate;
    const nowMs = this.clock.nowMs();
    const waiting = await this.queue.length(eventId);
    launchMetrics.queueLength.set(waiting, { event: eventId });
    if (waiting === 0) {
      await this.queue.retire(eventId);
      return 0;
    }
    const rate = gate.admissionRatePerSec;
    const bucket =
      (await this.queue.bucket(eventId)) ?? fullBucket(rate, nowMs);
    let total = 0;
    let state = bucket;
    // The bucket may hold more than one batch only at very high rates; each round re-reads nothing, it only subtracts.
    for (;;) {
      const want = Math.min(BATCH, waiting - total);
      const taken = takeFromBucket(state, nowMs, rate, want);
      if (taken.granted === 0) break;
      const refilled = {
        tokens: taken.state.tokens + taken.granted,
        atMs: nowMs,
      };
      const peek = await this.queue.peek({
        eventId,
        want: taken.granted,
        fence,
        nowMs,
      });
      if (peek.stale) return this.stale(total);
      if (peek.tickets.length === 0) break;
      const items: AdmittedItem[] = await Promise.all(
        peek.tickets.map(async (candidate) => {
          const issued = await this.tokens.issue({
            eventId,
            userId: candidate.userId,
            ticket: candidate.ticket,
          });
          return {
            ...candidate,
            token: issued.token,
            tokenExpiresAtMs: issued.expiresAtMs,
          };
        }),
      );
      const done = await this.queue.commit({
        eventId,
        fence,
        nowMs,
        items,
        bucketBefore: refilled,
      });
      if (done.stale) return this.stale(total);
      total += done.admitted.length;
      launchMetrics.admitted.add(done.admitted.length);
      await Promise.all(done.admitted.map((item) => this.push(eventId, item)));
      state = { tokens: refilled.tokens - done.admitted.length, atMs: nowMs };
      if (done.admitted.length < peek.tickets.length || total >= waiting) break;
    }
    return total;
  }

  private stale(admittedBefore: number): number {
    launchMetrics.staleLeader.add(1);
    return admittedBefore;
  }

  private async push(eventId: string, item: AdmittedItem): Promise<void> {
    try {
      await this.realtime.publish(`queue:${item.ticket}`, 'admitted', {
        eventId,
        admissionToken: item.token,
        tokenExpiresAt: new Date(item.tokenExpiresAtMs).toISOString(),
      });
    } catch {
      // The buyer's status poll still returns the token; a missed push is only a slower path.
      launchMetrics.publishFailed.add(1);
    }
  }
}

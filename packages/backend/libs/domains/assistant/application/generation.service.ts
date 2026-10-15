import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { ReadinessService } from '@app/infrastructure/health';
import {
  ADMISSION_STORE,
  GENERATION_STORE,
  type AdmissionStore,
  type GenerationStore,
  type StoredEvent,
} from '../domain/assistant-ports';
import type { GenerationState } from '../domain/generation-state';
import {
  Domain_GenerationFinished,
  Domain_GenerationNotFound,
} from './assistant-errors';
import {
  assistantAborts,
  assistantActiveStreams,
  assistantTurnDuration,
  assistantTurns,
} from './assistant-metrics';
import { logIds } from './turn-log';
import {
  TurnRunner,
  type AbortReason,
  type TurnControl,
  type TurnJob,
} from './turn-runner';

class Control implements TurnControl {
  private readonly controller = new AbortController();
  private why: AbortReason | null = null;
  readonly signal = this.controller.signal;

  abort(reason: AbortReason): void {
    if (this.why) return;
    this.why = reason;
    assistantAborts.add(1, { reason });
    this.controller.abort();
  }

  reason(): AbortReason | null {
    return this.why;
  }
}

interface LocalRun {
  control: Control;
  done: Promise<void>;
}

/**
 * Runs generations independently of the HTTP response that started them (S46 FR-003): liveness marker, abort when nobody
 * watches or the owner cancels, the turn deadline, reclaiming a generation whose process is gone, and the drain on
 * shutdown. The response is only one viewer of the generation store.
 */
@Injectable()
export class GenerationService implements OnModuleInit {
  private readonly logger = new Logger(GenerationService.name);
  private readonly running = new Map<string, LocalRun>();
  private draining = false;

  constructor(
    @Inject(GENERATION_STORE) private readonly store: GenerationStore,
    @Inject(ADMISSION_STORE) private readonly admission: AdmissionStore,
    private readonly runner: TurnRunner,
    private readonly config: ApiConfigService,
    @Optional() private readonly shutdown?: ShutdownRegistry,
    @Optional() private readonly readiness?: ReadinessService,
  ) {
    assistantActiveStreams.set(0);
  }

  onModuleInit() {
    this.shutdown?.register({
      name: 'assistant.generations',
      order: 30,
      phase: 'drain',
      timeoutMs: this.config.get('assistant_drain_ms') + 5_000,
      run: () => this.drain(),
    });
  }

  /** Readiness failed or the drain began: new sends are refused (AS-75). */
  isShuttingDown(): boolean {
    return this.draining || (this.readiness?.isShuttingDown() ?? false);
  }

  /** Starts the turn in the background; the caller attaches a viewer. */
  launch(job: TurnJob): void {
    const key = `${job.userId}:${job.messageId}`;
    const control = new Control();
    const startedAt = Date.now();
    const grace = this.config.get('assistant_detach_grace_ms');
    let lastSeen = Date.now();

    const offCancel = this.store.onCancel(job.userId, job.messageId, () =>
      control.abort('cancel'),
    );
    const turnTimer = setTimeout(
      () => control.abort('timeout'),
      this.config.get('assistant_turn_timeout_ms'),
    );
    const watcher = setInterval(
      () => {
        void this.watch(
          job,
          control,
          grace,
          () => lastSeen,
          (t) => (lastSeen = t),
        );
      },
      Math.max(20, Math.min(1_000, grace / 2)),
    );

    const done = this.runner
      .run(job, control)
      .then((outcome) => {
        assistantTurns.add(1, { outcome: outcome.label });
        assistantTurnDuration.record((Date.now() - startedAt) / 1000, {
          outcome: outcome.label,
        });
      })
      .catch(() =>
        this.logger.error(
          `turn crashed ${logIds({ requestId: job.requestId, conversationId: job.conversation.conversationId, messageId: job.messageId })}`,
        ),
      )
      .finally(() => {
        clearTimeout(turnTimer);
        clearInterval(watcher);
        offCancel();
        this.running.delete(key);
        assistantActiveStreams.set(this.running.size);
      });
    this.running.set(key, { control, done });
    assistantActiveStreams.set(this.running.size);
  }

  private async watch(
    job: TurnJob,
    control: Control,
    graceMs: number,
    seen: () => number,
    markSeen: (t: number) => void,
  ) {
    try {
      await this.store.heartbeat(job.userId, job.messageId);
      const meta = await this.store.meta(job.userId, job.messageId);
      if (meta?.cancelRequested) return control.abort('cancel');
      if (await this.store.hasViewers(job.userId, job.messageId))
        markSeen(Date.now());
      else if (Date.now() - seen() > graceMs) control.abort('detached');
    } catch {
      // A store hiccup: keep generating rather than abort a healthy turn.
    }
  }

  /** The stop button. Terminal generations answer 409, unknown or foreign ones 404 (AS-05, AS-29). */
  async cancel(userId: string, messageId: string): Promise<void> {
    const state: GenerationState | null = await this.store.requestCancel(
      userId,
      messageId,
    );
    if (state === null) throw new Domain_GenerationNotFound();
    if (state !== 'running') throw new Domain_GenerationFinished();
  }

  /**
   * A generation whose liveness marker is gone is reported lost exactly once, and its lock and slot are reclaimed
   * (AS-30). Any viewer or admission step may call this; the store's terminal guard makes racing callers harmless.
   */
  async reportIfLost(
    userId: string,
    messageId: string,
  ): Promise<StoredEvent | null> {
    if (!(await this.store.isLost(userId, messageId))) return null;
    const meta = await this.store.meta(userId, messageId);
    if (meta) {
      await this.admission.releaseLock(userId, meta.conversationId, messageId);
      await this.admission.releaseSlot(userId, messageId);
    }
    return this.store.finish(userId, messageId, {
      type: 'error',
      data: { code: 'GENERATION_LOST' },
    });
  }

  /** Frees a conversation lock held by a lost generation; true when the lock is free now. */
  async reclaimLock(userId: string, conversationId: string): Promise<boolean> {
    const holder = await this.admission.lockHolder(userId, conversationId);
    if (!holder) return true;
    await this.reportIfLost(userId, holder);
    return (await this.admission.lockHolder(userId, conversationId)) === null;
  }

  /** Frees the slots of lost generations of the user. */
  async reclaimSlots(userId: string): Promise<void> {
    for (const messageId of await this.admission.slotMembers(userId))
      await this.reportIfLost(userId, messageId);
  }

  /** Waits for local generations up to the drain period, then aborts the rest with `SHUTTING_DOWN`. */
  async drain(): Promise<void> {
    this.draining = true;
    const runs = [...this.running.values()];
    if (!runs.length) return;
    const all = Promise.allSettled(runs.map((r) => r.done));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(
        () => resolve('timeout'),
        this.config.get('assistant_drain_ms'),
      );
    });
    const winner = await Promise.race([
      all.then(() => 'drained' as const),
      timeout,
    ]);
    clearTimeout(timer);
    if (winner === 'timeout') {
      for (const run of runs) run.control.abort('shutdown');
      await all;
    }
  }

  /** Number of generations running on this instance. */
  localCount(): number {
    return this.running.size;
  }
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import type { VideoFailureCode } from '@marketplace-sandbox/contracts';
import { isOptionalTask, parseRungTask } from '../domain/dag';
import {
  LeaseLostError,
  PermanentTaskError,
  ShutdownTaskError,
  StorageTaskError,
} from '../domain/task-errors';
import {
  HEARTBEAT_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  nextAfterFailure,
  type AttemptFailure,
} from '../domain/task-limits';
import {
  VideoLogger,
  VideoMetrics,
  VideoStore,
  type TaskRecord,
  type VideoRecord,
} from '../domain/video-ports';
import { ChildAbortedError, ChildTimeoutError } from '../infra/child-process';
import { VIDEO_QUEUE, type VideoTaskMessage } from '../video.constants';
import { messageAttributes, queueAgeSeconds } from './video-messages';
import {
  attemptPrefix,
  VideoTaskRunner,
  type TaskRunResult,
} from './video-task-runner';

export type TaskOutcome =
  | 'done'
  | 'busy'
  | 'stale'
  | 'retry'
  | 'failed'
  | 'skipped'
  | 'timeout'
  | 'requeued'
  | 'lost';

export interface TaskDelivery {
  body: VideoTaskMessage;
  receiveCount: number;
  attributes: Record<string, string>;
}

const labelOf = (task: string): string =>
  parseRungTask(task) !== null ? 'transcode' : task;

/**
 * One delivery of a `video-transcode` message (S30 R-6–R-9, R-12). The worker claims the task (only `QUEUED`, or a
 * lease that ran out; a held lease is "busy" and costs no attempt), runs the body with the encoder bounded in time and
 * memory, and records the result in ONE transaction: the fenced `DONE`, the stored graph after `probe`, the guarded
 * `READY` after `publish`, and the fan-in that queues the next tasks. Messages go out after the commit. A running task
 * holds no database connection: claim, heartbeat and completion are separate short statements.
 */
@Injectable()
export class VideoPipelineService {
  constructor(
    private readonly store: VideoStore,
    private readonly runner: VideoTaskRunner,
    private readonly storage: ObjectStorage,
    private readonly queue: TaskQueue,
    private readonly metrics: VideoMetrics,
    private readonly logger: VideoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async handle(
    delivery: TaskDelivery,
    shutdown: AbortSignal,
  ): Promise<TaskOutcome> {
    const { videoId, task: name } = delivery.body;
    const label = labelOf(name);
    const trace = {
      ...(delivery.attributes.requestId && {
        requestId: delivery.attributes.requestId,
      }),
      ...(delivery.attributes.traceId && {
        traceId: delivery.attributes.traceId,
      }),
    };
    const startedAt = this.clock.nowMs();
    const age = queueAgeSeconds(this.clock, delivery.attributes);
    if (age !== null) this.metrics.observe('video_queue_age_seconds', age);
    const now = this.clock.now();
    const claim = await this.store.tasks.claim({
      videoId,
      name,
      now,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      maxAttempts: MAX_ATTEMPTS,
    });

    if (claim.outcome === 'busy' || claim.outcome === 'stale') {
      this.metrics.inc('video_task_total', {
        task: label,
        result: claim.outcome,
      });
      this.logger.info('task not run', {
        videoId,
        task: name,
        result: claim.outcome,
        ...trace,
      });
      return claim.outcome;
    }
    if (claim.outcome === 'exhausted') {
      // A lease ran out on the last attempt: no attempt is left to run, the task and the video fail.
      await this.failVideo(
        claim.task,
        'transcode_failed',
        'attempts exhausted',
      );
      this.metrics.inc('video_task_total', { task: label, result: 'failed' });
      return 'failed';
    }

    const { video, task } = claim;
    const attempt = task.claimedAttempt!;
    const lease = new AbortController();
    const signal = AbortSignal.any([shutdown, lease.signal]);
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void this.store.tasks
        .heartbeat({
          videoId,
          name,
          attempt,
          now: this.clock.now(),
          leaseUntil: new Date(this.clock.nowMs() + LEASE_MS),
        })
        .then((alive) => {
          if (!alive) {
            leaseLost = true;
            lease.abort();
          }
        })
        .catch(() => undefined); // a database hiccup: the next beat tries again, the lease is 5 minutes
    }, HEARTBEAT_MS);

    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    let outcome: TaskOutcome;
    try {
      const result = await this.runner.run({
        video,
        task,
        attempt,
        signal,
        workDir,
      });
      if (leaseLost) throw new LeaseLostError();
      outcome = await this.record(video, task, attempt, result, trace);
    } catch (error) {
      outcome = await this.onFailure({
        video,
        task,
        attempt,
        error,
        shutdown,
        leaseLost,
        trace,
      });
    } finally {
      clearInterval(heartbeat);
      await rm(workDir, { recursive: true, force: true });
    }

    this.metrics.inc('video_task_total', { task: label, result: outcome });
    this.metrics.observe(
      'video_task_seconds',
      (this.clock.nowMs() - startedAt) / 1000,
      {
        task: label,
      },
    );
    this.logger.info('task run', {
      videoId,
      task: name,
      attempt,
      result: outcome,
      ...trace,
    });
    return outcome;
  }

  // ---- success

  /** The completion transaction: fenced `DONE` + what the task decided + fan-in. Messages after the commit. */
  private async record(
    video: VideoRecord,
    task: TaskRecord,
    attempt: number,
    result: TaskRunResult,
    trace: Record<string, string>,
  ): Promise<TaskOutcome> {
    const now = this.clock.now();
    const { completed, ready, published } = await this.store.tx(
      async ({ video: videos, tasks }) => {
        // Video row first, task rows after (a delete takes them in that order too): no deadlock between the two.
        const status = await videos.lock(video.id);
        if (status !== 'PROCESSING')
          return { completed: false, ready: [] as string[], published: null };
        if (result.graph) {
          await videos.setProbe(video.id, result.probe!);
          await tasks.insertGraph(
            video.id,
            result.graph.filter((n) => n.name !== 'probe'),
            now,
          );
        }
        const done = await tasks.complete({
          videoId: video.id,
          name: task.name,
          attempt,
          output: result.output,
          now,
        });
        if (!done)
          return { completed: false, ready: [] as string[], published: null };
        let publishedRow: VideoRecord | null = null;
        if (result.outputs) {
          publishedRow = await videos.publish({
            id: video.id,
            outputs: result.outputs,
            now,
          });
          // The guard said no (a delete won): there is nothing to queue and nothing to announce.
          if (!publishedRow)
            return { completed: true, ready: [], published: null };
        }
        return {
          completed: true,
          ready: await tasks.dispatchReady(video.id, now),
          published: publishedRow,
        };
      },
    );

    if (!completed) {
      // This attempt lost its lease: its objects are not referenced by anything, remove them (AS-26).
      await this.removeAttemptObjects(video, task.name, attempt);
      return 'lost';
    }
    if (published) {
      this.metrics.inc('video_status_transitions_total', {
        from: 'PROCESSING',
        to: 'READY',
      });
      if (published.readyAt && video.createdAt)
        this.metrics.observe(
          'video_upload_to_ready_seconds',
          (published.readyAt.getTime() - video.createdAt.getTime()) / 1000,
        );
    }
    await this.send(video.id, ready, 0, trace);
    return 'done';
  }

  // ---- failure

  private classify(
    error: unknown,
    shutdown: AbortSignal,
    leaseLost: boolean,
  ): AttemptFailure | 'lost' {
    if (leaseLost || error instanceof LeaseLostError) return 'lost';
    if (error instanceof PermanentTaskError)
      return { kind: 'permanent', code: error.failureCode };
    if (error instanceof ChildTimeoutError) return { kind: 'timeout' };
    if (
      error instanceof ChildAbortedError ||
      error instanceof ShutdownTaskError
    )
      return shutdown.aborted ? { kind: 'shutdown' } : { kind: 'transient' };
    if (shutdown.aborted && (error as Error)?.name === 'AbortError')
      return { kind: 'shutdown' };
    if (error instanceof StorageTaskError) return { kind: 'storage' };
    return { kind: 'transient' };
  }

  private async onFailure(input: {
    video: VideoRecord;
    task: TaskRecord;
    attempt: number;
    error: unknown;
    shutdown: AbortSignal;
    leaseLost: boolean;
    trace: Record<string, string>;
  }): Promise<TaskOutcome> {
    const { video, task, attempt, error, trace } = input;
    const failure = this.classify(error, input.shutdown, input.leaseLost);
    const note = String((error as Error)?.message ?? error).slice(0, 500);
    const now = this.clock.now();

    if (failure === 'lost') {
      await this.removeAttemptObjects(video, task.name, attempt);
      return 'lost';
    }
    this.logger.warn('task attempt failed', {
      videoId: video.id,
      task: task.name,
      attempt,
      result: failure.kind,
      ...trace,
    });

    const decision = nextAfterFailure({
      failure,
      attempt,
      optional: isOptionalTask(task.name),
    });
    const common = {
      videoId: video.id,
      name: task.name,
      attempt,
      internalError: note,
      now,
    };

    if (decision.action === 'requeue') {
      // Shutdown: back to QUEUED, the attempt is given back, a fresh message follows at once.
      const back = await this.store.tasks.requeue({
        ...common,
        keepAttempt: true,
      });
      if (back) await this.send(video.id, [task.name], 0, trace);
      return 'requeued';
    }
    if (decision.action === 'retry') {
      const back = await this.store.tasks.requeue(common);
      if (back)
        await this.send(video.id, [task.name], decision.delaySec, trace);
      return failure.kind === 'timeout' ? 'timeout' : 'retry';
    }
    if (decision.action === 'skip') {
      const { skipped, ready } = await this.store.tx(
        async ({ video: videos, tasks }) => {
          await videos.lock(video.id);
          const ok = await tasks.skip(common);
          return {
            skipped: ok,
            ready: ok ? await tasks.dispatchReady(video.id, now) : [],
          };
        },
      );
      await this.send(video.id, ready, 0, trace);
      return skipped ? 'skipped' : 'lost';
    }
    await this.store.tx(async ({ video: videos, tasks }) => {
      await videos.lock(video.id);
      if (await tasks.failTask(common))
        await videos.fail({
          id: video.id,
          from: ['PROCESSING'],
          code: decision.failureCode as VideoFailureCode,
          internalError: note,
          actor: { type: 'worker' },
          now,
        });
    });
    this.metrics.inc('video_status_transitions_total', {
      from: 'PROCESSING',
      to: 'FAILED',
    });
    return failure.kind === 'timeout' ? 'timeout' : 'failed';
  }

  /** A task whose lease ran out on its last attempt: nothing can run it again. */
  private async failVideo(
    task: TaskRecord,
    code: VideoFailureCode,
    note: string,
  ) {
    const now = this.clock.now();
    await this.store.tx(async ({ video: videos, tasks }) => {
      await videos.lock(task.videoId);
      await tasks.failTask({
        videoId: task.videoId,
        name: task.name,
        attempt: task.claimedAttempt ?? task.attempts,
        internalError: note,
        now,
      });
      await videos.fail({
        id: task.videoId,
        from: ['PROCESSING'],
        code,
        internalError: note,
        actor: { type: 'system' },
        now,
      });
    });
  }

  // ---- shared

  private async removeAttemptObjects(
    video: VideoRecord,
    name: string,
    attempt: number,
  ) {
    const prefix = attemptPrefix(video, name, attempt);
    if (!prefix) return;
    await this.storage
      .deletePrefix(prefix, { limit: 100_000 })
      .catch((e: Error) =>
        this.logger.warn('could not remove the objects of a lost attempt', {
          videoId: video.id,
          task: name,
          attempt,
          reason: e.message.slice(0, 200),
        }),
      );
  }

  /** After the commit. A message lost here is found again by `media.video-requeue-stuck` (the task stays `QUEUED`). */
  private async send(
    videoId: string,
    names: string[],
    delaySeconds: number,
    trace: Record<string, string>,
  ): Promise<void> {
    for (const task of names) {
      try {
        await this.queue.enqueue(
          VIDEO_QUEUE,
          { videoId, task },
          {
            ...(delaySeconds > 0 && { delaySeconds }),
            attributes: messageAttributes(this.clock, trace),
          },
        );
      } catch (error) {
        this.logger.error('could not enqueue a task; the sweep will', {
          videoId,
          task,
          reason: (error as Error).message.slice(0, 200),
        });
      }
    }
  }
}

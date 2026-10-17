import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  JUDGE_QUEUE,
  judgeRequestSchema,
  type JudgeRequest,
} from '../application/events/judge-requested.event';
import { JudgeService } from '../application/judge.service';
import { ShopFunctionsConfig } from '../application/shop-functions.config';

/**
 * The single consumer of the judge queue (S45 FR-019, IV.5). The payload is validated by the queue port (an invalid one
 * goes to the dead-letter queue with reason `SCHEMA_INVALID`, nothing changes); a version that is missing or already
 * terminal is acknowledged with no effect; a `QUEUED` one is claimed and a `TESTING` one judged again. Readiness fails
 * while the queue or its dead-letter queue is not defined (L-002).
 */
@Injectable()
export class JudgeConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly judge: JudgeService,
    private readonly config: ShopFunctionsConfig,
    @Optional() readiness?: ReadinessService,
  ) {
    readiness?.register({
      name: `queue:${JUDGE_QUEUE}`,
      scope: 'pod',
      timeoutMs: 2_000,
      check: async () => {
        for (const name of [JUDGE_QUEUE, `${JUDGE_QUEUE}-dlq`])
          if (!(await this.queue.queueExists(name)))
            throw new Error(`queue ${name} is not defined`);
      },
    });
  }

  onApplicationBootstrap(): void {
    this.stop = this.queue.consume<JudgeRequest>(
      JUDGE_QUEUE,
      async ({ body }) => {
        await this.judge.judge(body.functionId, body.version);
      },
      {
        concurrency: this.config.judgeConcurrency,
        visibilityTimeoutSec: 60,
        bodySchema: judgeRequestSchema,
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop?.();
  }
}

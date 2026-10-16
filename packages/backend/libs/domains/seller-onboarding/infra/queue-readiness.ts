import { Injectable, Optional } from '@nestjs/common';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { EXTRACTION_QUEUE } from '../application/onboarding-documents.service';

/**
 * The API produces the extraction commands (through the outbox relay) and a Lambda consumes them: readiness fails
 * while the queue or its dead-letter queue is not defined (L-002, S04 A5), so a missing queue is found at start and not
 * when the relay parks its first message.
 */
@Injectable()
export class ExtractionQueueReadiness {
  constructor(queue: TaskQueue, @Optional() readiness?: ReadinessService) {
    readiness?.register({
      name: `queue:${EXTRACTION_QUEUE}`,
      scope: 'pod',
      timeoutMs: 2_000,
      check: async () => {
        for (const name of [EXTRACTION_QUEUE, `${EXTRACTION_QUEUE}-dlq`])
          if (!(await queue.queueExists(name)))
            throw new Error(`queue ${name} is not defined`);
      },
    });
  }
}

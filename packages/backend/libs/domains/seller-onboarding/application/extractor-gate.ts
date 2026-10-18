import { Injectable } from '@nestjs/common';
import { ConsumerPauseFlags } from '@app/infrastructure/projections/consumer-pause';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { EXTRACTION_QUEUE } from './onboarding-documents.service';

/** The operator name of the extractor in the consumer control surface (S53 R-21): pause, resume and `state`. */
export const EXTRACTOR_GROUP = 'document-extractor';

/** How long a held message waits before it comes back to look at the flag again. */
const HOLD_SECONDS = 2;

/**
 * The operator's hold on document extraction (J02 AS-10, the extractor "down"). While `document-extractor` is paused a worker
 * does not claim the document: it puts the message back with a short delay and acknowledges this copy, so the document stays
 * `QUEUED`, nothing is read and no model is called, and the work resumes within seconds of the resume. It works for every
 * worker alike (the Lambda and the local deployment), because the flag lives in Redis.
 */
@Injectable()
export class ExtractorGate {
  constructor(
    private readonly flags: ConsumerPauseFlags,
    private readonly queue: TaskQueue,
  ) {}

  /** `true` when the extractor is held and the message was put back; the caller then does nothing else. */
  async holdIfPaused(documentId: string): Promise<boolean> {
    if (!(await this.flags.isPaused([EXTRACTOR_GROUP]))) return false;
    await this.queue.enqueue(
      EXTRACTION_QUEUE,
      { documentId },
      { delaySeconds: HOLD_SECONDS },
    );
    return true;
  }
}

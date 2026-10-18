import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ExtractionService } from '../application/extraction.service';
import {
  EXTRACTION_QUEUE,
  extractDocumentBody,
} from '../application/onboarding-documents.service';

/**
 * The document extractor inside the local deployment (J02 G-11, L-025): the same `ExtractionService` calls the Lambda
 * `document-extractor` makes, driven by the same queue, so a journey on a stack without a separate Lambda runner still gets
 * its documents decided from the first minute. A message parked in the dead-letter queue goes to human review, as
 * `document-extractor-dlq` does. Hosted only by the local monolith: a deployed environment consumes the queue with the Lambda
 * and never starts this class.
 */
@Injectable()
export class LocalDocumentExtractor
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LocalDocumentExtractor.name);
  private stops: Array<() => Promise<void>> = [];

  constructor(
    private readonly queue: TaskQueue,
    private readonly extraction: ExtractionService,
  ) {}

  onApplicationBootstrap(): void {
    this.stops.push(
      this.queue.consume<{ documentId: string }>(
        EXTRACTION_QUEUE,
        async ({ body }) => this.extraction.process(body.documentId),
        { concurrency: 2, bodySchema: extractDocumentBody },
      ),
      this.queue.consume<{ documentId: string }>(
        `${EXTRACTION_QUEUE}-dlq`,
        async ({ body }) =>
          this.extraction.routeToReview(
            body.documentId,
            'extraction_unavailable',
          ),
        { concurrency: 1, bodySchema: extractDocumentBody },
      ),
    );
    this.logger.log(`consuming ${EXTRACTION_QUEUE} (local deployment)`);
  }

  async onModuleDestroy(): Promise<void> {
    const stops = this.stops;
    this.stops = [];
    await Promise.allSettled(stops.map((stop) => stop()));
  }
}

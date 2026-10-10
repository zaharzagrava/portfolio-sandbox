import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import {
  embeddingFillMutation,
  embeddingHashOf,
  embeddingTextOf,
} from '../../domain/index-document';
import {
  EMBEDDING_PROVIDER,
  PRODUCT_INDEX,
  type EmbeddingProvider,
  type ProductIndexPort,
} from '../../domain/ports';
import '../../infra/search.jobs';

const BATCH = 100;

/**
 * Every 10 minutes: products indexed without a vector (the provider failed while projecting, `embeddingPending`)
 * get one, in batches of 100, only while the stored text is still the text the vector is made from (S32 AS-21).
 */
@Injectable()
export class BackfillEmbeddingsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackfillEmbeddingsJob.name);

  constructor(
    private readonly jobs: JobsService,
    @Inject(PRODUCT_INDEX) private readonly index: ProductIndexPort,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'search.backfill-embeddings',
        cron: '0 */10 * * * *',
        jobType: 'search.backfill-embeddings',
        payload: {},
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule not registered: ${error.message}`);
    }
  }

  @JobHandler('search.backfill-embeddings', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: 120_000,
  })
  async run(): Promise<{ filled: number; pending: number }> {
    const ids = await this.index.pendingEmbeddingIds(BATCH);
    if (ids.length === 0) return { filled: 0, pending: 0 };
    const docs = await this.index.read(ids);
    const items: Parameters<ProductIndexPort['mutate']>[0] = [];
    for (const [id, doc] of docs) {
      const text = embeddingTextOf({
        title: doc.title ?? '',
        description: doc.description ?? '',
        brand: doc.brand ?? '',
        category: doc.category ?? '',
        tags: doc.tags,
      });
      try {
        const vector = await this.embeddings.embed(text, AbortSignal.timeout(5_000));
        items.push({
          id,
          mutation: embeddingFillMutation({ hash: embeddingHashOf(text), vector }),
        });
      } catch {
        // the provider is still unwell: the document stays pending and the next run tries again
      }
    }
    const outcomes = await this.index.mutate(items);
    const filled = [...outcomes.values()].filter((o) => o === 'applied').length;
    this.logger.log({ action: 'search.embeddings_backfilled', filled, pending: ids.length - filled });
    return { filled, pending: ids.length - filled };
  }
}

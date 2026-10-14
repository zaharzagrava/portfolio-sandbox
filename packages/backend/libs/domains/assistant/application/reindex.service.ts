import { Inject, Injectable } from '@nestjs/common';
import {
  DOCUMENT_REPOSITORY,
  EMBEDDING_PROVIDER,
  TASK_PUBLISHER,
} from '../domain/ports';
import type {
  DocumentRepository,
  EmbeddingProvider,
  TaskPublisher,
} from '../domain/ports';

const BATCH = 500;

/**
 * Administrator re-index after the embedding model changed (S47 FR-013, AS-41). Idempotent: only `READY` documents whose
 * passages were produced by another model move to `QUEUED` (one conditional update each), so a second call while they
 * are queued enqueues nothing. The old passages keep answering (by keywords, and by meaning for the new model's) until
 * the atomic swap of each document.
 */
@Injectable()
export class ReindexService {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    @Inject(TASK_PUBLISHER) private readonly tasks: TaskPublisher,
  ) {}

  async reindex(): Promise<{ enqueued: number }> {
    let enqueued = 0;
    for (;;) {
      const ids = await this.documents.queueStaleModel(
        this.embedder.model,
        BATCH,
      );
      for (const id of ids) await this.tasks.enqueueIngest(id);
      enqueued += ids.length;
      if (ids.length < BATCH) return { enqueued };
    }
  }
}

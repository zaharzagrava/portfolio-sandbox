import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { Environment } from '@app/common/types';
import { ANSWER_MODEL, EMBEDDING_PROVIDER } from '../domain/ports';
import type { AnswerModel, EmbeddingProvider } from '../domain/ports';
import { EMBEDDING_DIMS } from './embedder';

/**
 * Runtime half of the production guards (S47 AS-54, FR-042); the config half (a missing embedding key, a missing
 * moderation backend or cursor key) is `knowledgeProductionRule`. In production this refuses to start with the
 * deterministic test embedder, an embedding model whose dimension is not 1,024, or the scripted model provider: a
 * production index built from hash vectors would be silently wrong forever. Messages name the key, never a value. Outside
 * production nothing is refused.
 */
@Injectable()
export class KnowledgeConfigGuard implements OnModuleInit {
  constructor(
    private readonly config: ApiConfigService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    /** Absent in apps that never answer (the worker). */
    @Optional()
    @Inject(ANSWER_MODEL)
    private readonly model?: AnswerModel,
  ) {}

  onModuleInit(): void {
    if (this.config.get('node_env') !== Environment.production) return;
    const problems: string[] = [];
    if (this.embedder.testOnly)
      problems.push(
        'voyage_api_key: the deterministic test embedder is not allowed in production',
      );
    if (this.embedder.dimensions !== EMBEDDING_DIMS)
      problems.push(
        `voyage_model: the embedding dimension must be ${EMBEDDING_DIMS}`,
      );
    if (this.model?.scripted)
      problems.push(
        'anthropic_api_key: the scripted model provider is not allowed in production',
      );
    if (problems.length)
      throw new Error(`[knowledge] startup refused: ${problems.join('; ')}`);
  }
}

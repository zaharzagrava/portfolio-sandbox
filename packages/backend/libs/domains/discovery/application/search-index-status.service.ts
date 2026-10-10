import { Inject, Injectable } from '@nestjs/common';
import type { SearchIndexStatus } from '@marketplace-sandbox/contracts';
import { MAPPING_VERSION } from '../domain/index-definition';
import { isTerminal } from '../domain/reindex-run-status';
import {
  INDEX_MANAGER,
  PROJECTION_LAG,
  REINDEX_RUN_REPOSITORY,
  SYNONYM_SET_REPOSITORY,
  type IndexManagerPort,
  type ProjectionLagPort,
  type ReindexRunRepository,
  type SynonymSetRepository,
} from '../domain/ports';
import { IndexBootstrapService } from '../infra/index-bootstrap.service';
import { PRODUCTS_ALIAS } from '../infra/search-index-names';

/** `GET /admin/search/index`: the live index, the retained one, versions, counts and the runs around now (S32 AS-77). */
@Injectable()
export class SearchIndexStatusService {
  constructor(
    @Inject(INDEX_MANAGER) private readonly manager: IndexManagerPort,
    @Inject(REINDEX_RUN_REPOSITORY) private readonly runs: ReindexRunRepository,
    @Inject(SYNONYM_SET_REPOSITORY)
    private readonly synonyms: SynonymSetRepository,
    @Inject(PROJECTION_LAG) private readonly lag: ProjectionLagPort,
    private readonly bootstrap: IndexBootstrapService,
  ) {}

  async status(): Promise<SearchIndexStatus> {
    let live = await this.manager.liveIndex();
    if (!live) {
      await this.bootstrap.ensureLiveIndex();
      live = await this.manager.liveIndex();
    }
    const [info, activeRun, latest, synonyms, lagSeconds] = await Promise.all([
      live ? this.manager.info(live.name) : null,
      this.runs.findActive(),
      this.runs.latestCompleted(),
      this.synonyms.current(),
      this.lag.seconds(),
    ]);
    const lastRun = (await this.runs.list(10, null)).find((r) => isTerminal(r.status)) ?? null;
    if (live) await this.manager.refresh(live.name);
    const mappingVersion = info?.mappingVersion ?? 0;
    return {
      alias: PRODUCTS_ALIAS,
      activeIndex: live?.name ?? '',
      previousIndex: latest?.previousIndex ?? null,
      previousRetiresAt: latest?.previousRetiresAt?.toISOString() ?? null,
      mappingVersion,
      expectedMappingVersion: MAPPING_VERSION,
      outdated: mappingVersion < MAPPING_VERSION,
      embeddingModelVersion: info?.embeddingModelVersion ?? '',
      documentCount: live ? await this.manager.countProducts(live.name) : 0,
      embeddingPendingCount: live
        ? await this.manager.countPendingEmbeddings(live.name)
        : 0,
      synonymsVersion: synonyms.version,
      projectionLagSeconds: lagSeconds,
      activeRun: activeRun
        ? { runId: activeRun.runId, status: activeRun.status }
        : null,
      lastRun: lastRun
        ? {
            runId: lastRun.runId,
            kind: lastRun.kind,
            status: lastRun.status,
            finishedAt: lastRun.finishedAt?.toISOString() ?? null,
          }
        : null,
    };
  }
}

import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import {
  MAPPING_VERSION,
  productsIndexDefinition,
} from '../domain/index-definition';
import {
  SYNONYM_SET_REPOSITORY,
  type SynonymSetRepository,
} from '../domain/ports';
import { PRODUCTS_ALIAS } from './search-index-names';
import { SearchSettings } from './search-settings';

/** The engine's name of the synonym set every products index references (research R-05). */
export const SYNONYMS_SET_ID = 'product-synonyms';

/** Name of the first index: fixed, so two instances starting together create the same one (the second finds it existing). */
export const INITIAL_INDEX = `products_m${MAPPING_VERSION}_init`;

/**
 * First-start bootstrap (AS-50): when neither the alias nor any index exists, create one empty versioned index behind
 * it, race-safely. An existing alias (or a legacy concrete `products` index, which the first run replaces) is never
 * touched: mapping changes happen only through a reindex run (FR-030, FR-038).
 */
@Injectable()
export class IndexBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IndexBootstrapService.name);
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly engine: SearchEngineClient,
    private readonly settings: SearchSettings,
    @Inject(SYNONYM_SET_REPOSITORY)
    private readonly synonyms: SynonymSetRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ensureLiveIndex();
    } catch (error) {
      // The engine may be down at boot; the first write or read retries (SearchIndexRegistry).
      this.logger.warn(
        `search index bootstrap skipped: ${(error as Error).message}`,
      );
    }
  }

  ensureLiveIndex(): Promise<void> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Makes sure the engine holds the committed synonym set (new indices reference it by name). */
  async ensureSynonymsSet(): Promise<void> {
    if ((await this.engine.getSynonyms(SYNONYMS_SET_ID)) !== null) return;
    const { rules } = await this.synonyms.current();
    await this.engine.putSynonyms(SYNONYMS_SET_ID, rules);
  }

  private async run(): Promise<void> {
    if ((await this.engine.aliasTargets(PRODUCTS_ALIAS)).length > 0) return;
    // A concrete index named like the alias (before aliases were used) stays until a run replaces it atomically.
    if (await this.engine.indexExists(PRODUCTS_ALIAS)) return;
    await this.ensureSynonymsSet();
    const created = await this.engine.createIndex(INITIAL_INDEX, {
      ...productsIndexDefinition(this.settings.indexProfile),
      aliases: { [PRODUCTS_ALIAS]: {} },
    });
    if (created)
      this.logger.log(
        `created index ${INITIAL_INDEX} behind alias ${PRODUCTS_ALIAS}`,
      );
  }
}

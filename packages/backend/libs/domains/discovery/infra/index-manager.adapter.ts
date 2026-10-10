import { Injectable } from '@nestjs/common';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import {
  MAPPING_VERSION,
  productsIndexDefinition,
} from '../domain/index-definition';
import type { IndexInfo, IndexManagerPort } from '../domain/ports';
import { IndexBootstrapService } from './index-bootstrap.service';
import { PRODUCTS_ALIAS } from './search-index-names';
import { SearchSettings } from './search-settings';

const PRODUCT_DOCUMENTS = {
  bool: {
    filter: [{ term: { hasProduct: true } }, { term: { deleted: false } }],
  },
};

/** Index lifecycle over the generic engine client: create beside the live one, switch atomically, count, delete. */
@Injectable()
export class SearchIndexManager implements IndexManagerPort {
  constructor(
    private readonly engine: SearchEngineClient,
    private readonly settings: SearchSettings,
    private readonly bootstrap: IndexBootstrapService,
  ) {}

  async liveIndex(): Promise<{ name: string; concrete: boolean } | null> {
    const [target] = await this.engine.aliasTargets(PRODUCTS_ALIAS);
    if (target) return { name: target, concrete: false };
    return (await this.engine.indexExists(PRODUCTS_ALIAS))
      ? { name: PRODUCTS_ALIAS, concrete: true }
      : null;
  }

  async createFor(runId: string): Promise<string> {
    const name = `products_m${MAPPING_VERSION}_${runId.replace(/-/g, '').slice(0, 12)}`;
    await this.bootstrap.ensureSynonymsSet();
    await this.engine.createIndex(
      name,
      productsIndexDefinition(this.settings.indexProfile, runId),
    );
    return name;
  }

  async deleteUnlessLive(name: string): Promise<boolean> {
    const live = await this.liveIndex();
    if (live?.name === name) return false;
    await this.engine.deleteIndex(name);
    return true;
  }

  async info(name: string): Promise<IndexInfo | null> {
    const found = await this.engine.listIndices(name);
    return this.toInfo(name, found[name]) ?? null;
  }

  async productIndices(): Promise<IndexInfo[]> {
    const found = await this.engine.listIndices('products_*');
    return Object.entries(found).map(([name, i]) => this.toInfo(name, i)!);
  }

  async refresh(index: string): Promise<void> {
    await this.engine.refresh(index);
  }

  countProducts(index: string): Promise<number> {
    return this.engine.count(index, PRODUCT_DOCUMENTS);
  }

  countPendingEmbeddings(index: string): Promise<number> {
    return this.engine.count(index, {
      bool: {
        filter: [
          ...PRODUCT_DOCUMENTS.bool.filter,
          { term: { embeddingPending: true } },
        ],
      },
    });
  }

  async switchLive(target: string): Promise<void> {
    const live = await this.liveIndex();
    const actions: Record<string, Record<string, unknown>>[] = [];
    if (live?.concrete) {
      actions.push({ remove_index: { index: PRODUCTS_ALIAS } });
    } else if (live) {
      for (const index of await this.engine.aliasTargets(PRODUCTS_ALIAS))
        actions.push({ remove: { index, alias: PRODUCTS_ALIAS } });
    }
    actions.push({ add: { index: target, alias: PRODUCTS_ALIAS } });
    // one request: there is no instant at which the name points to nothing or to two indices
    await this.engine.updateAliases(actions);
  }

  private toInfo(
    name: string,
    found:
      | { meta: Record<string, unknown>; aliases: string[]; createdAt: number | null }
      | undefined,
  ): IndexInfo | undefined {
    if (!found) return undefined;
    const meta = found.meta as {
      mappingVersion?: number;
      embeddingModelVersion?: string;
      createdByRun?: string | null;
    };
    return {
      name,
      mappingVersion: meta.mappingVersion ?? null,
      embeddingModelVersion: meta.embeddingModelVersion ?? null,
      createdByRun: meta.createdByRun ?? null,
      createdAt: found.createdAt ? new Date(found.createdAt) : null,
    };
  }
}

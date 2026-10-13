import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { ProductQueryService } from '@app/domains/catalog';
import {
  boardClosed,
  boardNotFound,
  serviceUnavailable,
} from '../domain/discussion-errors';
import type { BoardGate } from '../domain/ports';

/**
 * Anti-corruption adapter over catalog's exported batch lookup (S25 A1, FR-001, D-12): the only importer of
 * `ProductQueryService` in discussions. Used on writes only; reads never consult the catalog.
 */
@Injectable()
export class CatalogBoardGateAdapter implements BoardGate {
  constructor(
    private readonly products: ProductQueryService,
    private readonly config: ApiConfigService,
  ) {}

  async assertOpen(productId: string): Promise<void> {
    const timeoutMs = this.config.get('discussions_catalog_timeout_ms');
    let timer: NodeJS.Timeout | undefined;
    let found;
    try {
      found = await Promise.race([
        this.products.getProductsByIds([productId]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('catalog timeout')),
            timeoutMs,
          );
        }),
      ]);
    } catch {
      throw serviceUnavailable();
    } finally {
      if (timer) clearTimeout(timer);
    }
    const product = found.get(productId.toLowerCase());
    if (!product) throw boardNotFound();
    if (product.status !== 'ACTIVE') throw boardClosed();
  }
}

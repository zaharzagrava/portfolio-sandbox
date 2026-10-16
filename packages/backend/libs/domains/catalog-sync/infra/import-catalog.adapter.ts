import { Injectable } from '@nestjs/common';
import { ProductImportService, ShopNotActiveError } from '@app/domains/catalog';
import { ImportFailureError } from '../domain/import-errors';
import type { ParsedItem } from '../domain/import-row';
import type { ImportCatalogGateway, ImportUpsertResult } from '../domain/ports';

/** One call to the catalog carries at most 500 items; this is the budget for it (IV.6). */
export const CATALOG_CALL_DEADLINE_MS = 60_000;

/**
 * The catalog's exported import command (R1; S05 `ProductImportService.upsertFromExternal`), source `"import"`. This is
 * the only way the import writes a product: no raw product SQL, no `catalog.product_changed`. A shop that
 * is no longer active is the permanent failure `shop_not_active`. The call is not retried here (one retry layer).
 */
@Injectable()
export class ImportCatalogAdapter implements ImportCatalogGateway {
  constructor(private readonly products: ProductImportService) {}

  async upsert(
    shopId: string,
    items: ParsedItem[],
    signal?: AbortSignal,
  ): Promise<ImportUpsertResult[]> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('catalog call exceeded its deadline')),
        CATALOG_CALL_DEADLINE_MS,
      );
      if (signal) {
        onAbort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error('aborted', { cause: signal.reason }),
          );
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    interrupted.catch(() => undefined);
    try {
      const results = await Promise.race([
        this.products.upsertFromExternal(shopId, items, 'import'),
        interrupted,
      ]);
      return results.map((r) => ({
        externalSku: r.externalSku,
        outcome: r.outcome,
        errors: r.errors,
      }));
    } catch (error) {
      if (error instanceof ShopNotActiveError)
        throw new ImportFailureError('shop_not_active');
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
}

import type { ParsedItem } from '../import-row';

export const IMPORT_CATALOG = Symbol('IMPORT_CATALOG');

export interface ImportUpsertResult {
  externalSku: string;
  outcome: 'created' | 'updated' | 'unchanged' | 'rejected';
  errors?: Array<{ field: string; code: string }>;
}

/**
 * The catalog's import command (S05 `ProductImportService.upsertFromExternal`): 1 to 500 items, results in the order of
 * the items. A shop that is not active throws `ImportFailureError('shop_not_active')`; a bad item is `rejected`.
 */
export interface ImportCatalogGateway {
  upsert(
    shopId: string,
    items: ParsedItem[],
    signal?: AbortSignal,
  ): Promise<ImportUpsertResult[]>;
}

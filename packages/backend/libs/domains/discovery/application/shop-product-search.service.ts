import { Inject, Injectable } from '@nestjs/common';
import {
  shopProductSearchQuerySchema,
  type ShopProductSearchResponse,
} from '@marketplace-sandbox/contracts';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchFingerprint,
} from '../domain/search-cursor';
import {
  InvalidCursorError,
  SearchValidationError,
} from '../domain/search-errors';
import { exceedsQueryLimit, normaliseQuery } from '../domain/query-text';
import {
  SHOP_SEARCH_REPOSITORY,
  type ShopSearchRepository,
} from '../domain/ports';

/**
 * The seller's product search (S32 US7) over the discovery-owned `SearchShopProduct` table: the shop id is part of every
 * query, the cursor is bound to shop, text and status, and the text only ever travels as a bind parameter. Whether the
 * caller may read this shop was decided by the route's `ShopScoped` guard before this runs.
 */
@Injectable()
export class ShopProductSearchService {
  constructor(
    @Inject(SHOP_SEARCH_REPOSITORY)
    private readonly products: ShopSearchRepository,
  ) {}

  async search(
    shopId: string,
    rawQuery: Record<string, unknown>,
  ): Promise<ShopProductSearchResponse> {
    const parsed = shopProductSearchQuerySchema.safeParse(rawQuery);
    if (!parsed.success)
      throw new SearchValidationError([
        ...new Set(
          parsed.error.issues.flatMap((issue) =>
            issue.code === 'unrecognized_keys'
              ? issue.keys
              : [String(issue.path[0] ?? 'query')],
          ),
        ),
      ]);
    const { q: raw, status, limit, cursor } = parsed.data;
    const q = normaliseQuery(raw);
    if (q === '' || exceedsQueryLimit(raw))
      throw new SearchValidationError(['q']);

    const fingerprint = searchFingerprint({
      q,
      filters: { shopId, ...(status && { status }) },
      sort: 'rank',
      mode: 'shop',
    });
    let after: Parameters<ShopSearchRepository['search']>[0]['after'] = null;
    if (cursor !== undefined) {
      const position = decodeSearchCursor(cursor, fingerprint);
      const [mode, rank] = position.sv;
      if ((mode !== 'fts' && mode !== 'trgm') || typeof rank !== 'number')
        throw new InvalidCursorError();
      after = { mode, rank, id: position.id };
    }

    const rows = await this.products.search({
      shopId,
      q,
      ...(status && { status }),
      limit: limit + 1,
      after,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(({ mode: _mode, ...item }) => item),
      nextCursor:
        rows.length > limit && last
          ? encodeSearchCursor(
              { sv: [last.mode, last.rank], id: last.id },
              fingerprint,
            )
          : null,
    };
  }
}

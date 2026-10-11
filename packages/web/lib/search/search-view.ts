/**
 * The view state of `/search` (W02 FR-020, data-model §2): the parsed address is the only copy of what the shopper
 * selected. Parsing is strict and total: an invalid part is dropped, never rejected, and the canonical address (fixed
 * parameter order, defaults omitted) replaces the current entry when it differs.
 */

export const SEARCH_SORT_VALUES = ['price-asc', 'price-desc', 'newest'] as const;
export type SearchViewSort = (typeof SEARCH_SORT_VALUES)[number];

/** Pickup radius choices; 5 is the default and never appears in the address. */
export const RADIUS_CHOICES = [1, 2, 5, 10, 20, 50] as const;
export const DEFAULT_RADIUS_KM = 5;
export const SEARCH_PAGE_SIZE = 24;

const MAX_Q = 100;
const MAX_FACET = 100;
const MAX_CURSOR = 2048;

export type SearchView = {
  /** Trimmed, 1..100. Absent means browse mode. */
  q?: string;
  category?: string;
  brand?: string;
  minPriceMinor?: number;
  maxPriceMinor?: number;
  /** Integer 1..5. */
  minRating?: number;
  inStock?: true;
  /** `relevance` is the default with `q` and never stored. */
  sort?: SearchViewSort;
  semantic?: true;
  near?: 1;
  /** Never 5. */
  radiusKm?: number;
  cursor?: string;
};

export type RawSearchParams = URLSearchParams | Record<string, string | string[] | undefined> | null | undefined;

const PARAM_ORDER = [
  'q',
  'category',
  'brand',
  'minPriceMinor',
  'maxPriceMinor',
  'minRating',
  'inStock',
  'sort',
  'semantic',
  'near',
  'radiusKm',
  'cursor',
] as const satisfies readonly (keyof SearchView)[];

const FILTER_KEYS = ['category', 'brand', 'minPriceMinor', 'maxPriceMinor', 'minRating', 'inStock', 'semantic', 'near', 'radiusKm'] as const;

/** Every `[name, value]` pair of the input, repeats included, in order. */
function pairsOf(raw: RawSearchParams): [string, string][] {
  if (!raw) return [];
  if (raw instanceof URLSearchParams) return [...raw.entries()];
  const pairs: [string, string][] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') pairs.push([name, value]);
    else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') pairs.push([name, item]);
  }
  return pairs;
}

const toInt = (value: string | undefined): number | undefined =>
  value !== undefined && /^[0-9]{1,15}$/.test(value) ? Number(value) : undefined;

const cutCodePoints = (text: string, max: number) => (Array.from(text).length > max ? Array.from(text).slice(0, max).join('') : text);

/** Applies every rule of FR-020 to an already de-duplicated record (first value wins upstream). */
function sanitize(input: Record<string, string | number | true | 1 | undefined>): SearchView {
  const view: SearchView = {};
  const text = (name: string) => (typeof input[name] === 'string' ? (input[name] as string) : undefined);

  const q = text('q') !== undefined ? cutCodePoints(text('q')!.trim(), MAX_Q).trim() : '';
  if (q) view.q = q;

  for (const name of ['category', 'brand'] as const) {
    const value = text(name);
    if (value && value.trim() !== '' && Array.from(value).length <= MAX_FACET) view[name] = value;
  }

  const min = typeof input.minPriceMinor === 'number' ? input.minPriceMinor : toInt(text('minPriceMinor'));
  const max = typeof input.maxPriceMinor === 'number' ? input.maxPriceMinor : toInt(text('maxPriceMinor'));
  const safe = (n: number | undefined) => (n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined);
  const lo = safe(min);
  const hi = safe(max);
  if (lo !== undefined && hi !== undefined && lo > hi) {
    // inverted range: both dropped
  } else {
    if (lo !== undefined) view.minPriceMinor = lo;
    if (hi !== undefined) view.maxPriceMinor = hi;
  }

  const rating = typeof input.minRating === 'number' ? input.minRating : toInt(text('minRating'));
  if (rating !== undefined && Number.isInteger(rating) && rating >= 1 && rating <= 5) view.minRating = rating;

  if (input.inStock === true || text('inStock') === 'true') view.inStock = true;

  const sort = text('sort');
  if (sort && (SEARCH_SORT_VALUES as readonly string[]).includes(sort)) view.sort = sort as SearchViewSort;

  if ((input.semantic === true || text('semantic') === 'true') && view.q) view.semantic = true;

  if (input.near === 1 || text('near') === '1') view.near = 1;

  const radius = typeof input.radiusKm === 'number' ? input.radiusKm : toInt(text('radiusKm'));
  if (radius !== undefined && (RADIUS_CHOICES as readonly number[]).includes(radius) && radius !== DEFAULT_RADIUS_KM) view.radiusKm = radius;

  const cursor = text('cursor');
  if (cursor && cursor.length <= MAX_CURSOR) view.cursor = cursor;

  return view;
}

/** The canonical query string of a view: fixed order, defaults omitted. */
export function toSearchParams(view: SearchView): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of PARAM_ORDER) {
    const value = view[name];
    if (value === undefined) continue;
    params.set(name, String(value));
  }
  return params;
}

/**
 * Parses the address. `changed` is true when the input differs from the canonical form (unknown or legacy names, repeats,
 * invalid values, a different order), so the caller can replace the current history entry with the canonical address.
 */
export function parseSearchView(raw: RawSearchParams): { view: SearchView; changed: boolean } {
  try {
    const pairs = pairsOf(raw);
    const first: Record<string, string> = {};
    for (const [name, value] of pairs) if (!(name in first)) first[name] = value;
    const view = sanitize(first);
    const changed = new URLSearchParams(pairs).toString() !== toSearchParams(view).toString();
    return { view, changed };
  } catch {
    return { view: {}, changed: true };
  }
}

/** Re-applies the rules to a view with a change on top; any change except the cursor itself removes the cursor. */
export function withChange(view: SearchView, patch: Partial<SearchView>): SearchView {
  const merged: Record<string, string | number | true | 1 | undefined> = { ...view };
  for (const [name, value] of Object.entries(patch)) merged[name] = value as never;
  const onlyCursor = Object.keys(patch).every((name) => name === 'cursor');
  if (!onlyCursor) delete merged.cursor;
  return sanitize(merged);
}

/** Clear all filters: `q` and `sort` stay (data-model §2). */
export function clearFilters(view: SearchView): SearchView {
  const next: SearchView = {};
  if (view.q) next.q = view.q;
  if (view.sort) next.sort = view.sort;
  return next;
}

/** Back to first page. */
export function firstPage(view: SearchView): SearchView {
  const { cursor: _cursor, ...rest } = view;
  void _cursor;
  return rest;
}

export function hasActiveFilters(view: SearchView): boolean {
  return FILTER_KEYS.some((name) => name !== 'near' && name !== 'radiusKm' && view[name] !== undefined);
}

/**
 * The parameters of the API call. Search: the canonical filters plus `limit=24` and `facets=true` (omitted for semantic).
 * With `near=1` only `q`, `radiusKm` and `cursor` go, plus the coordinates when given; the other filter values stay in
 * the address and in the disabled controls (AS-30).
 */
export function searchRequestParams(view: SearchView, coords?: { lat: number; lng: number }): URLSearchParams {
  const params = new URLSearchParams();
  if (view.near) {
    if (view.q) params.set('q', view.q);
    params.set('radiusKm', String(view.radiusKm ?? DEFAULT_RADIUS_KM));
    if (view.cursor) params.set('cursor', view.cursor);
    if (coords) {
      params.set('lat', String(coords.lat));
      params.set('lng', String(coords.lng));
    }
    return params;
  }
  if (view.q) params.set('q', view.q);
  if (view.category) params.set('category', view.category);
  if (view.brand) params.set('brand', view.brand);
  if (view.minPriceMinor !== undefined) params.set('minPriceMinor', String(view.minPriceMinor));
  if (view.maxPriceMinor !== undefined) params.set('maxPriceMinor', String(view.maxPriceMinor));
  if (view.minRating !== undefined) params.set('minRating', String(view.minRating));
  if (view.inStock) params.set('inStock', 'true');
  if (view.sort) params.set('sort', view.sort);
  if (view.semantic) params.set('semantic', 'true');
  else params.set('facets', 'true');
  params.set('limit', String(SEARCH_PAGE_SIZE));
  if (view.cursor) params.set('cursor', view.cursor);
  return params;
}

/** Stable text for query keys: equal views give equal text. */
export function canonicalKeyPart(view: SearchView): string {
  return toSearchParams(sanitize({ ...view })).toString();
}

/** The view without pickup mode: pickup search belongs to a later story, so the results read ignores `near` and its radius. */
export function withoutPickup(view: SearchView): SearchView {
  const { near: _near, radiusKm: _radius, ...rest } = view;
  void _near;
  void _radius;
  return rest;
}

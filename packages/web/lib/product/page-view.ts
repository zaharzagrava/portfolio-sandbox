/**
 * The view state of `/products/[productId]` in the address (W02 data-model §3): the tab, and the discussion list's sort,
 * window and expanded post, plus the attribution inputs `ref` and `ad`. Parsing is total; an invalid value is dropped.
 */
export const PRODUCT_TABS = ['details', 'pickup', 'ask', 'discussions'] as const;
export type ProductTab = (typeof PRODUCT_TABS)[number];
export const DISCUSSION_SORTS = ['hot', 'top', 'new'] as const;
export type DiscussionSort = (typeof DISCUSSION_SORTS)[number];
export const DISCUSSION_WINDOWS = ['day', 'week', 'month', 'year'] as const;
export type DiscussionWindow = (typeof DISCUSSION_WINDOWS)[number];

export type ProductPageView = {
  tab: ProductTab;
  sort: DiscussionSort;
  /** Only with `sort=top`; absent means "all time". */
  window?: DiscussionWindow;
  post?: string;
  ref?: string;
  ad?: '1';
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^[A-Za-z0-9_-]{1,64}$/;

type Raw = URLSearchParams | Record<string, string | string[] | undefined> | null | undefined;

function firstValue(raw: Raw, name: string): string | undefined {
  if (!raw) return undefined;
  if (raw instanceof URLSearchParams) return raw.get(name) ?? undefined;
  const value = raw[name];
  return Array.isArray(value) ? value[0] : value;
}

const oneOf = <T extends string>(allowed: readonly T[], value: string | undefined): T | undefined =>
  allowed.find((item) => item === value);

export function parseProductPageView(raw: Raw): ProductPageView {
  const sort = oneOf(DISCUSSION_SORTS, firstValue(raw, 'sort')) ?? 'hot';
  const window = sort === 'top' ? oneOf(DISCUSSION_WINDOWS, firstValue(raw, 'window')) : undefined;
  const post = firstValue(raw, 'post');
  const ref = firstValue(raw, 'ref');
  return {
    tab: oneOf(PRODUCT_TABS, firstValue(raw, 'tab')) ?? 'details',
    sort,
    ...(window ? { window } : {}),
    ...(post && UUID.test(post) ? { post } : {}),
    ...(ref && REF.test(ref) ? { ref } : {}),
    ...(firstValue(raw, 'ad') === '1' ? { ad: '1' as const } : {}),
  };
}

/** The query string of a view: fixed order, defaults omitted. */
export function productViewParams(view: Partial<ProductPageView>): URLSearchParams {
  const params = new URLSearchParams();
  if (view.tab && view.tab !== 'details') params.set('tab', view.tab);
  if (view.sort && view.sort !== 'hot') params.set('sort', view.sort);
  if (view.sort === 'top' && view.window) params.set('window', view.window);
  if (view.post) params.set('post', view.post);
  if (view.ref) params.set('ref', view.ref);
  if (view.ad) params.set('ad', view.ad);
  return params;
}

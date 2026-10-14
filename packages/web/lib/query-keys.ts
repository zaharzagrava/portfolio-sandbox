import { roundBounds, roundCoords, clampZoom, type Bounds, type Coords } from '@/lib/pickup/coords';
import { canonicalKeyPart, type SearchView } from '@/lib/search/search-view';

/** Object params in a key: sorted by name, undefined dropped, so equal parameters give equal keys. */
const canonical = (params: Record<string, string | number | boolean | undefined>) =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)));

const normalisePrefix = (prefix: string) => prefix.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** The only source of TanStack Query keys. W02 keys are tuples built here (spec FR-154). */
export const queryKeys = {
  products: {
    all: ['products'],
    detail: (id: string) => ['products', id],
  },
  search: {
    results: (view: SearchView) => ['search', 'results', canonicalKeyPart(view)] as const,
    near: (view: SearchView, coords: Coords) => ['search', 'near', canonicalKeyPart(view), roundCoords(coords)] as const,
  },
  suggest: {
    prefix: (prefix: string) => ['suggest', 'prefix', normalisePrefix(prefix)] as const,
  },
  rails: {
    trending: (category = 'all') => ['rails', 'trending', category] as const,
    recommendations: (productId: string) => ['rails', 'recommendations', productId] as const,
  },
  product: {
    page: (productId: string) => ['product', 'page', productId] as const,
  },
  pickup: {
    near: (productId: string, params: { radiusKm: number } & Coords) =>
      ['pickup', 'near', productId, canonical({ radiusKm: params.radiusKm, ...roundCoords(params) })] as const,
    clusters: (productId: string, bounds: Bounds, zoom: number) =>
      ['pickup', 'clusters', productId, roundBounds(bounds), clampZoom(zoom)] as const,
  },
  discussions: {
    board: (productId: string, params: { sort: string; window?: string }) => ['discussions', 'board', productId, canonical(params)] as const,
    thread: (postId: string, sort: string) => ['discussions', 'thread', postId, sort] as const,
    replies: (commentId: string) => ['discussions', 'replies', commentId] as const,
  },
  share: {
    link: (productId: string) => ['share', 'link', productId] as const,
  },
  video: {
    playback: (videoId: string) => ['video', 'playback', videoId] as const,
  },
  ads: {
    sponsored: (category?: string) => ['ads', 'sponsored', category ?? 'all'] as const,
  },
  cart: {
    all: ['cart'] as const,
    lines: () => ['cart', 'lines'] as const,
    page: () => ['cart', 'page'] as const,
    lastMerge: () => ['cart', 'lastMerge'] as const,
  },
  auth: {
    session: () => ['auth', 'session'] as const,
    mfaStatus: () => ['auth', 'mfa-status'] as const,
    sessions: () => ['auth', 'sessions'] as const,
    identities: () => ['auth', 'identities'] as const,
    oidcProviders: () => ['auth', 'oidc-providers'] as const,
  },
  orders: {
    all: ['orders'] as const,
    list: (params: { cursor?: string }) => ['orders', 'list', canonical({ cursor: params.cursor })] as const,
    detail: (id: string) => ['orders', 'detail', id] as const,
  },
  payments: {
    all: ['payments'] as const,
    detail: (id: string) => ['payments', 'detail', id] as const,
  },
  chat: {
    channels: ['chat', 'channels'],
    messages: (channelId: string) => ['chat', 'messages', channelId],
  },
  notifications: {
    all: ['notifications'] as const,
    unreadCount: () => ['notifications', 'unreadCount'] as const,
    inbox: () => ['notifications', 'inbox'] as const,
    preferences: () => ['notifications', 'preferences'] as const,
    devices: () => ['notifications', 'devices'] as const,
  },
  developers: {
    openapi: ['developers', 'openapi'] as const,
  },
  seller: {
    dashboard: (shopId: string) => ['seller', shopId, 'dashboard'],
    products: (shopId: string) => ['seller', shopId, 'products'],
  },
};

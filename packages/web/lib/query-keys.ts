import { roundBounds, roundCoords, clampZoom, type Bounds, type Coords } from '@/lib/pickup/coords';
import { canonicalKeyPart, type SearchView } from '@/lib/search/search-view';

/** Object params in a key: sorted by name, undefined dropped, so equal parameters give equal keys. */
const canonical = (params: Record<string, string | number | boolean | undefined>) =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)));

const normalisePrefix = (prefix: string) => prefix.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/** The sections of a seller shop; the second element after `['seller', shopId]` of every per-shop key. */
export type SellerSection =
  | 'shop'
  | 'overview'
  | 'inventory'
  | 'product'
  | 'orders'
  | 'team'
  | 'api-keys'
  | 'api-version'
  | 'logs'
  | 'usage'
  | 'finance'
  | 'imports'
  | 'exports'
  | 'webhooks'
  | 'webhook-event-types'
  | 'webhook'
  | 'webhook-attempts'
  | 'webhook-event'
  | 'ads'
  | 'widget'
  | 'knowledge'
  | 'media'
  | 'integrations'
  | 'drafts';

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
    buyAgainFailures: () => ['cart', 'buyAgainFailures'] as const,
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
  /** W04: every per-shop key starts with `['seller', shopId, section]`, so `scope(shopId, section)` invalidates a whole section. */
  seller: {
    /** Prefix of every seller key: the reconnect refetch (AS-88) invalidates it. */
    all: () => ['seller'] as const,
    shops: () => ['seller', 'shops'] as const,
    shop: (shopId: string) => ['seller', shopId, 'shop'] as const,
    scope: (shopId: string, section: SellerSection) => ['seller', shopId, section] as const,
    overview: (shopId: string, params: { days?: number }) => ['seller', shopId, 'overview', canonical(params)] as const,
    inventory: (shopId: string, params: { q?: string; status?: string; inStock?: boolean; cursor?: string }) => ['seller', shopId, 'inventory', canonical(params)] as const,
    product: (shopId: string, productId: string) => ['seller', shopId, 'product', productId] as const,
    orders: (shopId: string, params: { status?: string; cursor?: string }) => ['seller', shopId, 'orders', canonical(params)] as const,
    team: {
      members: (shopId: string, params: { cursor?: string }) => ['seller', shopId, 'team', 'members', canonical(params)] as const,
      invites: (shopId: string, params: { status?: string; cursor?: string }) => ['seller', shopId, 'team', 'invites', canonical(params)] as const,
      roles: () => ['seller', 'team', 'roles'] as const,
    },
    apiKeys: (shopId: string, params: { cursor?: string }) => ['seller', shopId, 'api-keys', canonical(params)] as const,
    apiVersion: (shopId: string) => ['seller', shopId, 'api-version'] as const,
    logs: (shopId: string, filters: Record<string, string | number | boolean | undefined>) => ['seller', shopId, 'logs', canonical(filters)] as const,
    finance: (shopId: string, ...parts: (string | undefined)[]) => ['seller', shopId, 'finance', ...parts] as const,
    imports: (shopId: string, ...parts: (string | undefined)[]) => ['seller', shopId, 'imports', ...parts] as const,
    exports: (shopId: string, ...parts: (string | undefined)[]) => ['seller', shopId, 'exports', ...parts] as const,
    usage: (shopId: string, params: { days?: number; livemode?: boolean }) => ['seller', shopId, 'usage', canonical(params)] as const,
    webhooks: (shopId: string, params: { cursor?: string }) => ['seller', shopId, 'webhooks', canonical(params)] as const,
    webhookEventTypes: (shopId: string) => ['seller', shopId, 'webhook-event-types'] as const,
    webhook: (shopId: string, endpointId: string) => ['seller', shopId, 'webhook', endpointId] as const,
    webhookAttempts: (shopId: string, endpointId: string, params: { ok?: boolean; cursor?: string }) =>
      ['seller', shopId, 'webhook-attempts', endpointId, canonical(params)] as const,
    webhookEvent: (shopId: string, endpointId: string, eventId: string) => ['seller', shopId, 'webhook-event', endpointId, eventId] as const,
    adCampaigns: (shopId: string, params: { status?: string; cursor?: string }) => ['seller', shopId, 'ads', 'campaigns', canonical(params)] as const,
    adCampaignDetail: (shopId: string, campaignId: string) => ['seller', shopId, 'ads', 'detail', campaignId] as const,
    adBilling: (shopId: string, campaignId: string, params: { from?: string; to?: string; cursor?: string }) => ['seller', shopId, 'ads', 'billing', campaignId, canonical(params)] as const,
    widgetSites: (shopId: string, params: { cursor?: string }) => ['seller', shopId, 'widget', 'sites', canonical(params)] as const,
    knowledgeDocuments: (shopId: string, params: { status?: string; cursor?: string }) => ['seller', shopId, 'knowledge', 'documents', canonical(params)] as const,
    /** F6 (S29, S30): the product gallery, one photo's processing state, the shop's videos and one video. */
    gallery: (shopId: string, productId: string) => ['seller', shopId, 'media', 'gallery', productId] as const,
    mediaItem: (shopId: string, mediaId: string) => ['seller', shopId, 'media', 'item', mediaId] as const,
    videos: (shopId: string, params: { productId?: string; cursor?: string }) => ['seller', shopId, 'media', 'videos', canonical(params)] as const,
    video: (shopId: string, videoId: string) => ['seller', shopId, 'media', 'video', videoId] as const,
    /** F3 (S08, S09): integrations and what hangs off one integration. */
    integrations: (shopId: string, params: { cursor?: string }) => ['seller', shopId, 'integrations', 'list', canonical(params)] as const,
    integration: (shopId: string, integrationId: string) => ['seller', shopId, 'integrations', 'one', integrationId] as const,
    quarantine: (shopId: string, integrationId: string, params: { status?: string; cursor?: string }) => ['seller', shopId, 'integrations', 'quarantine', integrationId, canonical(params)] as const,
    reconciliations: (shopId: string, integrationId: string, params: { cursor?: string }) => ['seller', shopId, 'integrations', 'reconciliations', integrationId, canonical(params)] as const,
    reconciliation: (shopId: string, integrationId: string, runId: string) => ['seller', shopId, 'integrations', 'reconciliation', integrationId, runId] as const,
    conflicts: (shopId: string, integrationId: string, params: { status?: string; cursor?: string }) => ['seller', shopId, 'integrations', 'conflicts', integrationId, canonical(params)] as const,
    offlineConflicts: (shopId: string, params: { status?: string; cursor?: string }) => ['seller', shopId, 'integrations', 'offline-conflicts', canonical(params)] as const,
    /** F1 (S06): the drafts of a product's editor and a draft's versions. */
    drafts: (shopId: string, params: { productId?: string; status?: string; cursor?: string }) => ['seller', shopId, 'drafts', 'list', canonical(params)] as const,
    draftVersions: (shopId: string, draftId: string) => ['seller', shopId, 'drafts', 'versions', draftId] as const,
  },
};

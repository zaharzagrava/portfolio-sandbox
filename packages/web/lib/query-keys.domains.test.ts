import { describe, expect, it } from 'vitest';
import { queryKeys } from './query-keys';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const view = { q: 'a' };
const coords = { lat: 1, lng: 2 };
const bounds = { south: 1, west: 2, north: 3, east: 4 };

/** Arguments to build one key of each factory; a new factory without an entry here fails the first test. */
const samples: Record<string, unknown[]> = {
  'products.detail': [ID],
  'admin.flags.list': [{ status: 'killed' }],
  'admin.flags.detail': ['new-checkout'],
  'admin.flags.history': ['new-checkout', {}],
  'admin.flags.stale': [{ days: 14 }],
  'search.results': [view],
  'search.near': [view, coords],
  'suggest.prefix': ['iph'],
  'rails.trending': ['all'],
  'rails.recommendations': [ID],
  'product.page': [ID],
  'pickup.near': [ID, { radiusKm: 5, ...coords }],
  'pickup.clusters': [ID, bounds, 11],
  'discussions.board': [ID, { sort: 'hot' }],
  'discussions.thread': [ID, 'top'],
  'discussions.replies': [ID],
  'share.link': [ID],
  'video.playback': [ID],
  'ads.sponsored': ['audio'],
  'cart.lines': [],
  'cart.page': [],
  'cart.lastMerge': [],
  'cart.buyAgainFailures': [],
  'auth.session': [],
  'auth.mfaStatus': [],
  'auth.sessions': [],
  'auth.identities': [],
  'auth.oidcProviders': [],
  'orders.list': [{}],
  'orders.detail': [ID],
  'payments.detail': [ID],
  'chat.inbox': [],
  'chat.unreadTotal': [],
  'chat.channel': [ID],
  'chat.byProduct': [ID],
  'chat.messages': [ID],
  'chat.receipts': [ID],
  'chat.presence': [ID],
  'assistant.conversations': [],
  'assistant.history': [ID],
  'assistant.usage': [],
  'notifications.unreadCount': [],
  'notifications.inbox': [],
  'notifications.preferences': [],
  'notifications.devices': [],
  'seller.shops': [],
  'seller.shop': [ID],
  'seller.scope': [ID, 'inventory'],
  'seller.overview': [ID, { days: 30 }],
  'seller.inventory': [ID, { q: 'mug', status: 'ACTIVE' }],
  'seller.product': [ID, ID],
  'seller.orders': [ID, {}],
  'seller.team.members': [ID, {}],
  'seller.team.invites': [ID, { status: 'pending' }],
  'seller.team.roles': [],
  'seller.apiKeys': [ID, {}],
  'seller.apiVersion': [ID],
  'seller.logs': [ID, { status: '4xx' }],
  'seller.usage': [ID, { days: 30, livemode: true }],
  'seller.webhooks': [ID, {}],
  'seller.webhookEventTypes': [ID],
  'seller.webhook': [ID, ID],
  'seller.webhookAttempts': [ID, ID, { ok: false }],
  'seller.webhookEvent': [ID, ID, ID],
  'seller.adCampaigns': [ID, { status: 'ACTIVE' }],
  'seller.adBilling': [ID, ID, {}],
  'seller.widgetSites': [ID, {}],
  'seller.knowledgeDocuments': [ID, { status: 'FAILED' }],
  'seller.all': [],
  'seller.finance': [ID, 'balance'],
  'seller.imports': [ID, 'list'],
  'seller.exports': [ID, 'list'],
  'seller.adCampaignDetail': [ID, ID],
  'seller.gallery': [ID, ID],
  'seller.mediaItem': [ID, ID],
  'seller.videos': [ID, { productId: ID }],
  'seller.video': [ID, ID],
  'seller.integrations': [ID, {}],
  'seller.integration': [ID, ID],
  'seller.quarantine': [ID, ID, { status: 'OPEN' }],
  'seller.reconciliations': [ID, ID, {}],
  'seller.reconciliation': [ID, ID, ID],
  'seller.conflicts': [ID, ID, {}],
  'seller.offlineConflicts': [ID, {}],
  'seller.drafts': [ID, {}],
  'seller.draftVersions': [ID, ID],
};

/** A group may nest one level (`seller.team.members`); the path joins the names with dots. */
function walk(domain: string, prefix: string, group: Record<string, unknown>, found: Array<{ path: string; domain: string; key: unknown }>) {
  for (const [name, entry] of Object.entries(group)) {
    const path = `${prefix}.${name}`;
    if (typeof entry === 'function') {
      if (!(path in samples)) {
        found.push({ path, domain, key: undefined });
        continue;
      }
      found.push({ path, domain, key: (entry as (...args: unknown[]) => unknown)(...samples[path]) });
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      walk(domain, path, entry as Record<string, unknown>, found);
    } else {
      found.push({ path, domain, key: entry });
    }
  }
}

function allKeys(): Array<{ path: string; domain: string; key: unknown }> {
  const found: Array<{ path: string; domain: string; key: unknown }> = [];
  for (const [domain, group] of Object.entries(queryKeys)) walk(domain, domain, group as Record<string, unknown>, found);
  return found;
}

describe('W07 query keys (AS-36)', () => {
  it('W07 AS-36: every key factory has a sample here, so none escapes the rule below', () => {
    const missing = allKeys().filter(({ key }) => key === undefined).map(({ path }) => path);
    expect(missing).toEqual([]);
  });

  it('W07 AS-36: every key is an array that starts with its domain name', () => {
    for (const { path, domain, key } of allKeys()) {
      expect(Array.isArray(key), path).toBe(true);
      expect((key as unknown[])[0], path).toBe(domain);
    }
  });

  it('W07 AS-36: no two different factories produce the same key (the "all" prefixes are the only shared heads)', () => {
    const seen = new Map<string, string>();
    for (const { path, key } of allKeys()) {
      const serialized = JSON.stringify(key);
      expect(seen.get(serialized), `${path} duplicates ${seen.get(serialized)}`).toBeUndefined();
      seen.set(serialized, path);
    }
  });

  it('W07 AS-36: the shell adds the developers.openapi key', () => {
    expect(queryKeys.developers.openapi).toEqual(['developers', 'openapi']);
  });
});

describe('W04 seller query keys (AS-92)', () => {
  const OTHER = '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f';
  const s = queryKeys.seller;

  it('W04 AS-92: the buyer-era dashboard and products keys are gone', () => {
    expect(Object.keys(s)).not.toContain('dashboard');
    expect(Object.keys(s)).not.toContain('products');
  });

  it('W04 AS-92: parameters are canonical, so equal views give equal keys and undefined parameters are dropped', () => {
    expect(s.inventory(ID, { q: 'mug', status: 'ACTIVE', inStock: undefined })).toEqual(s.inventory(ID, { status: 'ACTIVE', q: 'mug' }));
    expect(s.inventory(ID, { q: 'mug' })).not.toEqual(s.inventory(ID, { q: 'cup' }));
    expect(s.webhookAttempts(ID, ID, { ok: false })).not.toEqual(s.webhookAttempts(ID, ID, { ok: true }));
  });

  it('W04 AS-92: every per-shop key sits under scope(shopId, section), so one invalidation covers a section; shops do not mix', () => {
    const sections = {
      overview: s.overview(ID, { days: 7 }),
      inventory: s.inventory(ID, {}),
      orders: s.orders(ID, {}),
      apiKeys: s.apiKeys(ID, {}),
      webhooks: s.webhooks(ID, {}),
      logs: s.logs(ID, {}),
      usage: s.usage(ID, { days: 30, livemode: true }),
    } as const;
    const names: Record<keyof typeof sections, string> = {
      overview: 'overview',
      inventory: 'inventory',
      orders: 'orders',
      apiKeys: 'api-keys',
      webhooks: 'webhooks',
      logs: 'logs',
      usage: 'usage',
    };
    for (const [name, key] of Object.entries(sections)) {
      const scope = s.scope(ID, names[name as keyof typeof sections] as never);
      expect(key.slice(0, scope.length), name).toEqual(scope);
      expect(JSON.stringify(s.scope(OTHER, names[name as keyof typeof sections] as never))).not.toBe(JSON.stringify(scope));
    }
  });

  it('W04 AS-79: the roles matrix is not per shop; members and invites are', () => {
    expect(s.team.roles()).toEqual(['seller', 'team', 'roles']);
    expect(s.team.members(ID, {})).toContain(ID);
    expect(s.team.invites(ID, { status: 'pending' })).toContain(ID);
  });
});

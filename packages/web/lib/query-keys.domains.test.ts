import { describe, expect, it } from 'vitest';
import { queryKeys } from './query-keys';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const view = { q: 'a' };
const coords = { lat: 1, lng: 2 };
const bounds = { south: 1, west: 2, north: 3, east: 4 };

/** Arguments to build one key of each factory; a new factory without an entry here fails the first test. */
const samples: Record<string, unknown[]> = {
  'products.detail': [ID],
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
  'chat.messages': [ID],
  'notifications.unreadCount': [],
  'notifications.inbox': [],
  'notifications.preferences': [],
  'notifications.devices': [],
  'seller.dashboard': [ID],
  'seller.products': [ID],
};

function allKeys(): Array<{ path: string; domain: string; key: unknown }> {
  const found: Array<{ path: string; domain: string; key: unknown }> = [];
  for (const [domain, group] of Object.entries(queryKeys)) {
    for (const [name, entry] of Object.entries(group as Record<string, unknown>)) {
      const path = `${domain}.${name}`;
      if (typeof entry === 'function') {
        if (!(path in samples)) {
          found.push({ path, domain, key: undefined });
          continue;
        }
        found.push({ path, domain, key: (entry as (...args: unknown[]) => unknown)(...samples[path]) });
      } else {
        found.push({ path, domain, key: entry });
      }
    }
  }
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

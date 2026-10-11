import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { applyQueryDefaults } from './query-defaults';
import { queryKeys } from './query-keys';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';

describe('queryKeys', () => {
  it('W02 AS-71: every W02 key is a tuple built by the factory and starts with its root', () => {
    const keys = [
      queryKeys.search.results({ q: 'a' }),
      queryKeys.search.near({ q: 'a', near: 1 }, { lat: 1.234, lng: 5.678 }),
      queryKeys.suggest.prefix('iph'),
      queryKeys.rails.trending('all'),
      queryKeys.rails.recommendations(ID),
      queryKeys.product.page(ID),
      queryKeys.pickup.near(ID, { radiusKm: 5, lat: 1.234, lng: 5.678 }),
      queryKeys.pickup.clusters(ID, { south: 1, west: 2, north: 3, east: 4 }, 11),
      queryKeys.discussions.board(ID, { sort: 'hot' }),
      queryKeys.discussions.thread(ID, 'top'),
      queryKeys.discussions.replies(ID),
      queryKeys.share.link(ID),
      queryKeys.video.playback(ID),
      queryKeys.ads.sponsored('audio'),
    ];
    const roots = ['search', 'search', 'suggest', 'rails', 'rails', 'product', 'pickup', 'pickup', 'discussions', 'discussions', 'discussions', 'share', 'video', 'ads'];
    keys.forEach((key, index) => {
      expect(Array.isArray(key)).toBe(true);
      expect(key[0]).toBe(roots[index]);
      expect(() => JSON.stringify(key)).not.toThrow();
    });
  });

  it('W02 AS-71: equal search views share a key whatever their field order or leftovers', () => {
    expect(queryKeys.search.results({ q: 'a', category: 'c' })).toEqual(queryKeys.search.results({ category: 'c', q: 'a' }));
    expect(queryKeys.search.results({ q: 'a' })).not.toEqual(queryKeys.search.results({ q: 'b' }));
    expect(queryKeys.search.results({ q: 'a', cursor: 'x' })).not.toEqual(queryKeys.search.results({ q: 'a' }));
  });

  it('W02 AS-71: suggestion prefixes that differ only by case or spacing share a key', () => {
    expect(queryKeys.suggest.prefix('  iPh  one ')).toEqual(queryKeys.suggest.prefix('iph one'));
    expect(queryKeys.suggest.prefix('iph')).not.toEqual(queryKeys.suggest.prefix('ipx'));
  });

  it('W02 AS-71: object params are canonicalised: key order does not matter, coordinates are rounded to 3 decimals', () => {
    expect(queryKeys.discussions.board(ID, { window: 'week', sort: 'top' })).toEqual(queryKeys.discussions.board(ID, { sort: 'top', window: 'week' }));
    expect(queryKeys.pickup.near(ID, { radiusKm: 5, lat: 52.520001, lng: 13.40501 })).toEqual(queryKeys.pickup.near(ID, { lat: 52.52, lng: 13.405, radiusKm: 5 }));
    expect(queryKeys.pickup.near(ID, { radiusKm: 5, lat: 52.52, lng: 13.405 })).not.toEqual(queryKeys.pickup.near(ID, { radiusKm: 10, lat: 52.52, lng: 13.405 }));
  });

  it('W02 AS-71: per-key stale times follow the decision table', () => {
    const client = applyQueryDefaults(new QueryClient());
    const stale = (key: readonly unknown[]) => client.defaultQueryOptions({ queryKey: key }).staleTime;
    expect(stale(queryKeys.search.results({ q: 'a' }))).toBe(60_000);
    expect(stale(queryKeys.search.near({ near: 1 }, { lat: 1, lng: 2 }))).toBe(0);
    expect(client.defaultQueryOptions({ queryKey: queryKeys.search.near({ near: 1 }, { lat: 1, lng: 2 }) }).gcTime).toBe(0);
    expect(stale(queryKeys.suggest.prefix('a'))).toBe(60_000);
    expect(stale(queryKeys.rails.trending())).toBe(30_000);
    expect(stale(queryKeys.product.page(ID))).toBe(15_000);
    expect(stale(queryKeys.pickup.near(ID, { radiusKm: 5, lat: 1, lng: 2 }))).toBe(0);
    expect(stale(queryKeys.discussions.board(ID, { sort: 'hot' }))).toBe(30_000);
    expect(stale(queryKeys.share.link(ID))).toBe(Infinity);
    expect(stale(queryKeys.video.playback(ID))).toBe(0);
    expect(stale(queryKeys.ads.sponsored('audio'))).toBe(30_000);
  });

  it('W03 AS-71: cart, orders, payments and notifications keys are factory tuples under their roots', () => {
    expect(queryKeys.cart.all).toEqual(['cart']);
    expect(queryKeys.cart.lines()).toEqual(['cart', 'lines']);
    expect(queryKeys.cart.page()).toEqual(['cart', 'page']);
    expect(queryKeys.cart.lastMerge()).toEqual(['cart', 'lastMerge']);
    expect(queryKeys.orders.all).toEqual(['orders']);
    expect(queryKeys.orders.list({ cursor: 'tok' })).toEqual(['orders', 'list', { cursor: 'tok' }]);
    expect(queryKeys.orders.list({})).toEqual(['orders', 'list', {}]);
    expect(queryKeys.orders.detail(ID)).toEqual(['orders', 'detail', ID]);
    expect(queryKeys.payments.all).toEqual(['payments']);
    expect(queryKeys.payments.detail(ID)).toEqual(['payments', 'detail', ID]);
    expect(queryKeys.notifications.all).toEqual(['notifications']);
    expect(queryKeys.notifications.unreadCount()).toEqual(['notifications', 'unreadCount']);
    expect(queryKeys.notifications.inbox()).toEqual(['notifications', 'inbox']);
  });

  it('W03 AS-71: the cart key does not include a user id, and every cart key sits under the cart prefix', () => {
    for (const key of [queryKeys.cart.lines(), queryKeys.cart.page(), queryKeys.cart.lastMerge()]) expect(key.slice(0, 1)).toEqual(queryKeys.cart.all);
  });

  it('W03 FR-057: browser cache lifetimes follow the decision table', () => {
    const client = applyQueryDefaults(new QueryClient());
    const options = (key: readonly unknown[]) => client.defaultQueryOptions({ queryKey: key });
    expect(options(queryKeys.cart.lines()).staleTime).toBe(0);
    expect(options(queryKeys.cart.lines()).refetchOnWindowFocus).toBe(true);
    expect(options(queryKeys.cart.page()).staleTime).toBe(0);
    expect(options(queryKeys.cart.page()).refetchOnWindowFocus).toBe(true);
    expect(options(queryKeys.orders.list({})).staleTime).toBe(15_000);
    expect(options(queryKeys.orders.detail(ID)).staleTime).toBe(0);
    expect(options(queryKeys.payments.detail(ID)).staleTime).toBe(0);
    expect(options(queryKeys.notifications.unreadCount()).staleTime).toBe(30_000);
    expect(options(queryKeys.notifications.inbox()).staleTime).toBe(30_000);
  });

  it('W02 AS-71: the old products.search key is gone and the other roots are unchanged', () => {
    expect('search' in queryKeys.products).toBe(false);
    expect(queryKeys.cart.all).toEqual(['cart']);
    expect(queryKeys.auth.session()).toEqual(['auth', 'session']);
  });
});

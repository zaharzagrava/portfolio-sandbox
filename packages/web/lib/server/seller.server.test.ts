import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../vitest.setup';

const cookieJar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === '__Host-bff-session' && cookieJar.value ? { value: cookieJar.value } : undefined) }),
}));
vi.mock('@/lib/config', () => ({ config: { bffUrl: 'http://bff.test' } }));

import { overviewFixture, SELLER_SHOP_ID, sellerProblem, shopFixture, shopListItemFixture } from '@/lib/test/seller-handlers';
import { readInventoryFirstPage, readMyShops, readOverview, readShop } from './seller.server';

const bff = 'http://bff.test/api/bff';

describe('W04 seller.server', () => {
  beforeEach(() => {
    cookieJar.value = 'opaque';
  });

  it('W04 AS-85: a malformed, unknown or foreign shop id answers the same 404 shop_not_found value, and a malformed one sends no request', async () => {
    expect(await readShop('not-a-uuid')).toEqual({ ok: false, status: 404, code: 'shop_not_found' });
    expect(await readOverview('../etc/passwd', 30)).toEqual({ ok: false, status: 404, code: 'shop_not_found' });
    server.use(http.get(`${bff}/f/shops/${SELLER_SHOP_ID}`, () => sellerProblem('shop_not_found', { requestId: 'r1' })));
    expect(await readShop(SELLER_SHOP_ID)).toMatchObject({ ok: false, status: 404, code: 'shop_not_found' });
  });

  it('W04 AS-92: reads as the member with only the session cookie (never Authorization), parsed by the contract', async () => {
    let cookie: string | null = null;
    let auth: string | null = 'unset';
    server.use(
      http.get(`${bff}/f/shops/${SELLER_SHOP_ID}`, ({ request }) => {
        cookie = request.headers.get('cookie');
        auth = request.headers.get('authorization');
        return HttpResponse.json(shopFixture());
      }),
    );
    expect(await readShop(SELLER_SHOP_ID)).toMatchObject({ ok: true, data: { id: SELLER_SHOP_ID, myRole: 'OWNER' } });
    expect(cookie).toBe('__Host-bff-session=opaque');
    expect(auth).toBeNull();
  });

  it('W04 AS-16: the overview is the BFF aggregate for the period', async () => {
    let seen: URL | undefined;
    server.use(http.get(`${bff}/seller/${SELLER_SHOP_ID}/overview`, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json(overviewFixture()))));
    expect(await readOverview(SELLER_SHOP_ID, 7)).toMatchObject({ ok: true, data: { shop: { id: SELLER_SHOP_ID } } });
    expect(seen?.searchParams.get('days')).toBe('7');
  });

  it('W04 AS-08: my shops come through the forwarder with the switcher limit', async () => {
    let seen: URL | undefined;
    server.use(http.get(`${bff}/f/shops/mine`, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json({ items: [shopListItemFixture()], nextCursor: null }))));
    expect(await readMyShops()).toMatchObject({ ok: true, data: { items: [{ role: 'OWNER' }] } });
    expect(seen?.searchParams.get('limit')).toBe('50');
  });

  it('W04 AS-28: the first inventory page asks what the client later refetches (same parameters)', async () => {
    let seen: URL | undefined;
    server.use(http.get(`${bff}/f/shops/${SELLER_SHOP_ID}/products`, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json({ items: [], nextCursor: null }))));
    const result = await readInventoryFirstPage(SELLER_SHOP_ID, { q: '', status: 'ARCHIVED', inStock: false, cursor: undefined });
    expect(result).toMatchObject({ ok: true, data: { source: 'browse', items: [] } });
    expect(Object.fromEntries(seen!.searchParams)).toEqual({ status: 'ARCHIVED', inStock: 'false', limit: '20' });
  });

  it('W04 AS-87: without a session cookie the read is a 401 value, not a throw', async () => {
    cookieJar.value = undefined;
    expect(await readShop(SELLER_SHOP_ID)).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
  });
});

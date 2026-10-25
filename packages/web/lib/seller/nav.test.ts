import { describe, expect, it } from 'vitest';
import { currentPageLabel, isCurrentPath, legacyInventoryTarget, roleLabel, sectionOf, sellerNavItems, switchShopHref, accountNavLinks } from './nav';

const SHOP = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const OTHER = '11111111-2222-4333-8444-555555555555';
const base = `/dashboard/seller/${SHOP}`;

describe('W04 seller nav registry', () => {
  it('every entry points at its page (the sidebar links are a contract with the routes)', () => {
    const hrefs = Object.fromEntries(sellerNavItems.map((item) => [item.id, item.href(SHOP)]));
    expect(hrefs).toEqual({
      overview: base,
      inventory: `${base}/inventory`,
      orders: `${base}/orders`,
      team: `${base}/team`,
      payouts: `${base}/payouts`,
      statements: `${base}/statements`,
      imports: `${base}/imports`,
      exports: `${base}/exports`,
      integrations: `${base}/integrations`,
      campaigns: `${base}/campaigns`,
      widget: `${base}/widget`,
      knowledge: `${base}/knowledge`,
      'api-keys': `${base}/developers/api-keys`,
      webhooks: `${base}/developers/webhooks`,
      'api-version': `${base}/developers/api-version`,
      logs: `${base}/developers/logs`,
      usage: `${base}/developers/usage`,
      'api-docs': '/developers/docs',
    });
  });

  it('labels and groups', () => {
    expect(sellerNavItems.map((i) => [i.id, i.group, i.label])).toEqual([
      ['overview', 'shop', 'Overview'],
      ['inventory', 'shop', 'Inventory'],
      ['orders', 'shop', 'Orders'],
      ['team', 'shop', 'Team'],
      ['payouts', 'shop', 'Payouts'],
      ['statements', 'shop', 'Statements'],
      ['imports', 'shop', 'Import'],
      ['exports', 'shop', 'Order export'],
      ['integrations', 'shop', 'Integrations'],
      ['campaigns', 'shop', 'Campaigns'],
      ['widget', 'shop', 'Storefront widget'],
      ['knowledge', 'shop', 'Help documents'],
      ['api-keys', 'developers', 'API keys'],
      ['webhooks', 'developers', 'Webhooks'],
      ['api-version', 'developers', 'API version'],
      ['logs', 'developers', 'Request logs'],
      ['usage', 'developers', 'Usage'],
      ['api-docs', 'developers', 'API documentation'],
    ]);
    expect(accountNavLinks.map((l) => [l.id, l.label, l.href])).toEqual([
      ['my-orders', 'Your orders', '/orders'],
      ['account-security', 'Account security', '/account/security'],
    ]);
  });

  it('the shop id is percent-encoded in every link', () => {
    expect(sellerNavItems[1]?.href('a/b c')).toBe('/dashboard/seller/a%2Fb%20c/inventory');
  });
});

describe('W04 roleLabel', () => {
  it('known roles in words, unknown roles in sentence case', () => {
    expect([roleLabel('OWNER'), roleLabel('ADMIN'), roleLabel('STAFF'), roleLabel('VIEWER')]).toEqual(['Owner', 'Admin', 'Staff', 'Viewer']);
    expect(roleLabel('SUPPORT_AGENT')).toBe('Support_agent');
  });
});

describe('W04 isCurrentPath', () => {
  it('matches the page itself and its sub pages, not a sibling that shares the prefix', () => {
    expect(isCurrentPath(`${base}/inventory`, `${base}/inventory`)).toBe(true);
    expect(isCurrentPath(`${base}/inventory/`, `${base}/inventory`)).toBe(true);
    expect(isCurrentPath(`${base}/inventory/abc/media`, `${base}/inventory`)).toBe(true);
    expect(isCurrentPath(`${base}/inventory-old`, `${base}/inventory`)).toBe(false);
    expect(isCurrentPath(`${base}/orders`, `${base}/inventory`)).toBe(false);
  });

  it('exact mode (the overview) does not match sub pages, but ignores one trailing slash', () => {
    expect(isCurrentPath(base, base, true)).toBe(true);
    expect(isCurrentPath(`${base}/`, base, true)).toBe(true);
    expect(isCurrentPath(`${base}/orders`, base, true)).toBe(false);
    expect(isCurrentPath(`${base}/orders`, base)).toBe(true);
  });

  it('no pathname is never current; the root path keeps its slash', () => {
    expect(isCurrentPath(null, '/x')).toBe(false);
    expect(isCurrentPath(undefined, '/x')).toBe(false);
    expect(isCurrentPath('', '')).toBe(false);
    expect(isCurrentPath('/', '/', true)).toBe(true);
    expect(isCurrentPath('/', '', true)).toBe(false);
  });
});

describe('W04 sectionOf, switchShopHref, currentPageLabel', () => {
  it('sectionOf returns what follows the shop address', () => {
    expect(sectionOf(`${base}/inventory`, SHOP)).toBe('/inventory');
    expect(sectionOf(`${base}/developers/webhooks/abc`, SHOP)).toBe('/developers/webhooks/abc');
    expect(sectionOf(base, SHOP)).toBe('');
    expect(sectionOf(`${base}/`, SHOP)).toBe('');
    expect(sectionOf(`/dashboard/seller/${OTHER}/inventory`, SHOP)).toBe('');
    expect(sectionOf(`${base}-x/inventory`, SHOP)).toBe('');
    expect(sectionOf(null, SHOP)).toBe('');
  });

  it('switching shop keeps the section; a detail page falls back to the section', () => {
    expect(switchShopHref(`${base}/inventory`, SHOP, OTHER)).toBe(`/dashboard/seller/${OTHER}/inventory`);
    expect(switchShopHref(`${base}/orders/abc`, SHOP, OTHER)).toBe(`/dashboard/seller/${OTHER}/orders`);
    expect(switchShopHref(`${base}/developers/webhooks/ep_1`, SHOP, OTHER)).toBe(`/dashboard/seller/${OTHER}/developers/webhooks`);
    expect(switchShopHref(base, SHOP, OTHER)).toBe(`/dashboard/seller/${OTHER}`);
    expect(switchShopHref('/somewhere/else', SHOP, OTHER)).toBe(`/dashboard/seller/${OTHER}`);
  });

  it('the legacy inventory address goes to the one shop, otherwise to the picker', () => {
    expect(legacyInventoryTarget([{ id: SHOP }])).toBe(`${base}/inventory`);
    expect(legacyInventoryTarget([{ id: SHOP }, { id: OTHER }])).toBe('/dashboard/seller');
    expect(legacyInventoryTarget([])).toBe('/dashboard/seller');
  });

  it('currentPageLabel names the page; the overview is the fallback; API docs never counts', () => {
    expect(currentPageLabel(`${base}/inventory`, SHOP)).toBe('Inventory');
    expect(currentPageLabel(`${base}/orders/abc`, SHOP)).toBe('Orders');
    expect(currentPageLabel(`${base}/developers/webhooks/ep_1`, SHOP)).toBe('Webhooks');
    expect(currentPageLabel(base, SHOP)).toBe('Overview');
    expect(currentPageLabel(null, SHOP)).toBe('Overview');
    expect(currentPageLabel('/developers/docs', SHOP)).toBe('Overview');
    expect(currentPageLabel('/unknown', SHOP)).toBe('Overview');
  });
});

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ProductRails } from '@/components/product/product-rails';
import { parseProductPage } from '@/lib/product/parse-page';
import { PRODUCT_ID, recommendationsBody, SHOP_ID, trendingBody } from '@/lib/test/msw-handlers';

const OTHER = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a99';
const rec = (productId: string, title: string, priceMinor = 1500, currency = 'USD') => ({ productId, title, priceMinor, currency, score: 0.9, hops: 1 as const });
const trend = (productId: string, rank: number, title: string) => ({ rank, productId, title, priceMinor: 2500, currency: 'EUR', category: 'phones', score: 5 });

describe('ProductRails', () => {
  it('W02 AS-39: "Frequently bought together" shows the cards in the order given, with price from priceMinor and currency', () => {
    render(<ProductRails recommendations={[rec(OTHER, 'Case', 1500, 'USD'), rec(PRODUCT_ID, 'Charger', 2999, 'EUR')]} trending={null} category="phones" />);
    const section = screen.getByRole('region', { name: 'Frequently bought together' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Frequently bought together' })).toBeInTheDocument();
    const cards = within(section).getAllByTestId('rail-card');
    expect(cards.map((card) => card.textContent)).toEqual(['Case$15.00', 'Charger€29.99']);
    expect(within(section).getByRole('link', { name: /Case/ })).toHaveAttribute('href', `/products/${OTHER}`);
  });

  it('W02 AS-39: "Trending in {category}" shows the cards of the category', () => {
    render(<ProductRails recommendations={null} trending={[trend(OTHER, 1, 'Phone B')]} category="home-living" />);
    const section = screen.getByRole('region', { name: 'Trending in Home living' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Trending in Home living' })).toBeInTheDocument();
    expect(within(section).getByText('€25.00')).toBeInTheDocument();
  });

  it('W02 AS-39: a missing or empty section is not rendered at all, with no heading', () => {
    const { container, rerender } = render(<ProductRails recommendations={null} trending={null} category="phones" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ProductRails recommendations={[]} trending={[]} category="phones" />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('W02 AS-39: shows at most eight trending cards', () => {
    const many = Array.from({ length: 12 }, (_, i) => trend(`3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a${String(i + 10).padStart(2, '0')}`, i + 1, `T${i}`));
    render(<ProductRails recommendations={null} trending={many} category="phones" />);
    expect(screen.getAllByTestId('rail-card')).toHaveLength(8);
  });

  const body = (overrides: Record<string, unknown>) => ({
    product: {
      id: PRODUCT_ID, shopId: SHOP_ID, title: 'P', description: '', brand: 'B', category: 'phones', priceMinor: 100, currency: 'USD', rating: 0,
      tags: [], inStock: true, version: 1, viewCount: 0, updatedAt: '2026-10-10T10:00:00.000Z',
    },
    shop: null, recommendations: null, trending: null, flags: null, chatUnread: null, discussions: null, videos: null, gallery: null,
    pickup: null, flashSale: null, auction: null, errors: [], ...overrides,
  });

  it.each([
    ['empty items', { recommendations: recommendationsBody({ items: [] }) }],
    ['an invalid body', { recommendations: { type: 'bought-together', items: 'nope' } }],
    ['the rate-limited section being null', { recommendations: null, errors: [{ section: 'recommendations', code: 'UPSTREAM_RATE_LIMITED', retryable: true }] }],
    ['the unavailable section being null', { recommendations: null, errors: [{ section: 'recommendations', code: 'UPSTREAM_UNAVAILABLE', retryable: true }] }],
    ['the not-found section being null', { recommendations: null, errors: [{ section: 'recommendations', code: 'UPSTREAM_NOT_FOUND', retryable: false }] }],
  ])('W02 AS-39: %s leaves the section absent', (_name, overrides) => {
    const page = parseProductPage(body(overrides));
    const { container } = render(<ProductRails recommendations={page!.recommendations} trending={page!.trending} category="phones" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('W02 AS-39: the envelope is {type, items} and the product itself is removed from trending', () => {
    const page = parseProductPage(
      body({
        recommendations: recommendationsBody(),
        trending: trendingBody({ category: 'phones', items: [trend(PRODUCT_ID, 1, 'Self'), trend(OTHER, 2, 'Other')] }),
      }),
    );
    render(<ProductRails recommendations={page!.recommendations} trending={page!.trending} category="phones" />);
    expect(screen.queryByText('Self')).toBeNull();
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.getByText('Case')).toBeInTheDocument();
  });
});

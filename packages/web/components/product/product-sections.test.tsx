import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/products/x',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/components/add-to-cart-button', () => ({
  AddToCartButton: ({ disabled }: { disabled?: boolean }) => <button disabled={disabled}>{disabled ? 'Out of stock' : 'Add to cart'}</button>,
}));
vi.mock('@/components/product/share-popover', () => ({
  SharePopover: ({ destination }: { destination: string }) => <button data-destination={destination}>Share</button>,
}));
vi.mock('@/components/analytics/product-view', () => ({
  ProductView: ({ productId, category }: { productId: string; category: string }) => <i data-testid="product-view-mark" data-product={productId} data-category={category} />,
}));
vi.mock('@/components/product/video-section', () => ({
  VideoSection: ({ items }: { items: { title: string }[] }) => <section aria-label="Videos">{items.map((item) => item.title).join(',')}</section>,
}));
vi.mock('@/components/product/ask-panel', () => ({ AskPanel: () => <p>ask panel</p> }));
vi.mock('@/components/product/discussions/discussions-panel', () => ({ DiscussionsPanel: () => <p>discussions panel</p> }));

import { ProductSections } from '@/components/product/product-sections';
import { SectionBoundary } from '@/components/product/section-boundary';
import { parseProductPage } from '@/lib/product/parse-page';
import { PRODUCT_ID, SHOP_ID, recommendationsBody, trendingBody } from '@/lib/test/msw-handlers';

const product = {
  id: PRODUCT_ID, shopId: SHOP_ID, title: 'Espresso Machine', description: 'Makes coffee', brand: 'Acme', category: 'kitchen',
  priceMinor: 25000, currency: 'USD', rating: 4.2, tags: ['coffee'], inStock: true, version: 1, viewCount: 3, updatedAt: '2026-10-10T10:00:00.000Z',
};
const body = (overrides: Record<string, unknown> = {}) => ({
  product, shop: { id: SHOP_ID, name: 'Acme Store', slug: 'acme' },
  recommendations: recommendationsBody(), trending: trendingBody({ category: 'kitchen', items: [{ rank: 1, productId: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a99', title: 'Grinder', priceMinor: 9000, currency: 'USD', category: 'kitchen', score: 4 }] }),
  flags: null, chatUnread: null, discussions: null, videos: null,
  gallery: { items: [{ mediaId: '5f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a01', position: 0, urls: { thumb: 'https://m.example/t.jpg', feed: 'https://m.example/f.jpg', full: 'https://m.example/F.jpg' }, width: 1, height: 1 }] },
  pickup: null, flashSale: null, auction: null, errors: [], ...overrides,
});

const show = (overrides?: Record<string, unknown>) => {
  const page = parseProductPage(body(overrides));
  render(<ProductSections page={page!} siteUrl="https://shop.example.com" />);
};

const core = () => {
  expect(screen.getByRole('heading', { level: 1, name: 'Espresso Machine' })).toBeInTheDocument();
  expect(screen.getByTestId('product-price')).toHaveTextContent('$250.00');
  expect(screen.getByRole('button', { name: 'Add to cart' })).toBeEnabled();
  expect(screen.getByRole('tablist')).toBeInTheDocument();
};

describe('ProductSections', () => {
  it('W02 AS-60: Share is offered in the purchase area with the product address built from the site address', () => {
    show();
    const share = screen.getByRole('button', { name: 'Share' });
    expect(share).toHaveAttribute('data-destination', `https://shop.example.com/products/${PRODUCT_ID}`);
    expect(share.closest('[data-testid="purchase-area"]')).not.toBeNull();
  });

  it('W02 AS-60: a site address with a trailing slash does not double the slash', () => {
    const page = parseProductPage(body());
    render(<ProductSections page={page!} siteUrl="https://shop.example.com/" />);
    expect(screen.getByRole('button', { name: 'Share' })).toHaveAttribute('data-destination', `https://shop.example.com/products/${PRODUCT_ID}`);
  });

  it('W02 AS-67: the page carries one product view mark for this product and its category', () => {
    show();
    expect(screen.getByTestId('product-view-mark')).toHaveAttribute('data-product', PRODUCT_ID);
    expect(screen.getByTestId('product-view-mark')).toHaveAttribute('data-category', 'kitchen');
  });

  it('W02 AS-65: videos in the aggregate mount the Videos group in the Details tab', () => {
    show({ videos: { items: [{ videoId: '8a1f0c52-1111-4e6f-9a7b-1c2d3e4f5a01', title: 'Unboxing', posterUrl: null, durationSec: 125 }] } });
    const group = screen.getByRole('region', { name: 'Videos' });
    expect(group).toHaveTextContent('Unboxing');
    expect(group.closest('[role="tabpanel"]')).not.toBeNull();
    expect(screen.getByRole('tabpanel', { name: 'Details' })).toContainElement(group);
  });

  it('W02 AS-65: an empty videos section mounts nothing, and an invalid one does not break the page', () => {
    show({ videos: { items: [] } });
    expect(screen.queryByRole('region', { name: 'Videos' })).toBeNull();
    core();
  });

  it('W02 AS-34: an unparsable videos section is treated as missing', () => {
    show({ videos: { items: 'nope' } });
    expect(screen.queryByRole('region', { name: 'Videos' })).toBeNull();
    core();
  });

  it('W02 AS-65: with no videos section there is no Videos group and no player', () => {
    show();
    expect(screen.queryByText('Videos')).not.toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
  });

  it('W02 AS-32: a full page has the breadcrumb, gallery, summary, shop line, tabs and rails', () => {
    show();
    core();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Espresso Machine' })).toHaveAttribute('src', 'https://m.example/f.jpg');
    expect(screen.getByText('Sold by Acme Store')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Frequently bought together' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Trending in Kitchen' })).toBeInTheDocument();
    expect(document.querySelector('script[type="application/ld+json"]')).not.toBeNull();
  });

  it('W02 AS-40: the tabs are Details, Pickup near me, Ask about this product and Discussions, in that order', () => {
    show();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Details', 'Pickup near me', 'Ask about this product', 'Discussions']);
  });

  it('W02 AS-34: a missing shop hides the shop line only', () => {
    show({ shop: null });
    core();
    expect(screen.queryByText(/Sold by/)).toBeNull();
  });

  it('W02 AS-34: a missing gallery shows the placeholder image block', () => {
    show({ gallery: null });
    core();
    expect(screen.getByTestId('gallery-placeholder')).toBeInTheDocument();
  });

  it('W02 AS-34: missing recommendations and trending hide the sections without any heading', () => {
    show({ recommendations: null, trending: null });
    core();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByText(/Frequently bought|Trending in/)).toBeNull();
  });

  it('W02 AS-34: every optional section missing at once leaves the product, price, purchase area and tabs', () => {
    show({
      shop: null, recommendations: null, trending: null, gallery: null,
      errors: [
        { section: 'shop', code: 'UPSTREAM_TIMEOUT', retryable: true },
        { section: 'gallery', code: 'BUDGET_EXCEEDED', retryable: true },
        { section: 'recommendations', code: 'CIRCUIT_OPEN', retryable: true },
        { section: 'trending', code: 'UPSTREAM_UNAVAILABLE', retryable: true },
      ],
    });
    core();
  });

  it('W02 AS-34: invalid optional sections are treated as missing', () => {
    show({ shop: { nope: 1 }, recommendations: { items: 3 }, trending: 'x', gallery: { items: 'x' } });
    core();
    expect(screen.queryByText(/Sold by/)).toBeNull();
    expect(screen.queryByText(/Frequently bought|Trending in/)).toBeNull();
  });

  it('W02 AS-34: the error codes are never shown', () => {
    show({ gallery: null, errors: [{ section: 'gallery', code: 'BUDGET_EXCEEDED', retryable: true }] });
    expect(document.body.textContent).not.toMatch(/BUDGET_EXCEEDED|UPSTREAM_|CIRCUIT_OPEN|retryable/);
  });

  it('W02 AS-34: a rendering fault in an optional section is contained by its boundary', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('boom');
    }
    render(
      <>
        <p>page stays</p>
        <SectionBoundary>
          <Broken />
        </SectionBoundary>
      </>,
    );
    expect(screen.getByText('page stays')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('boom');
    consoleError.mockRestore();
  });

  it('W02 AS-32: structured data carries the same product, with "<" escaped', () => {
    show({ product: { ...product, title: '</script>x' } });
    const text = document.querySelector('script[type="application/ld+json"]')!.textContent!;
    expect(text).not.toContain('<');
    expect(JSON.parse(text)).toMatchObject({ name: '</script>x', offers: { priceCurrency: 'USD' } });
  });

  it('W02 AS-37: out of stock disables the purchase control', () => {
    show({ product: { ...product, inStock: false } });
    expect(screen.getByRole('button', { name: 'Out of stock' })).toBeDisabled();
  });
});

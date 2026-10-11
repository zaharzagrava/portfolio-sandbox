import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ProductPublicView } from '@marketplace-sandbox/contracts';
import { Breadcrumb } from '@/components/product/breadcrumb';
import { ProductSummary } from '@/components/product/product-summary';
import { productJsonLd } from '@/lib/seo/product-jsonld';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const product: ProductPublicView = {
  id: ID,
  shopId: '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f',
  title: 'Apple iPhone 17 Pro 256GB',
  description: 'Line one\nLine two <b>not bold</b>',
  brand: 'Apple',
  category: 'phones',
  priceMinor: 89999,
  currency: 'USD',
  rating: 4.5,
  tags: ['5g', 'smart phone'],
  inStock: true,
  version: 1,
  viewCount: 5,
  updatedAt: '2026-10-10T10:00:00.000Z',
};
const shop = { id: product.shopId, name: 'Acme <Store>', slug: 'acme' };

describe('Breadcrumb', () => {
  it('W02 AS-32: Home › category › title as a nav named Breadcrumb, the last item is the current page', () => {
    render(<Breadcrumb category="phones" title="Apple iPhone 17 Pro 256GB" />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav).toHaveTextContent('Home');
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'phones' })).toHaveAttribute('href', '/search?category=phones');
    expect(screen.getByText('Apple iPhone 17 Pro 256GB')).toHaveAttribute('aria-current', 'page');
  });
});

describe('ProductSummary', () => {
  it('W02 AS-32: title, brand link, rating, price from priceMinor and currency, stock', () => {
    render(<ProductSummary product={product} shop={shop} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Apple iPhone 17 Pro 256GB' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Apple' })).toHaveAttribute('href', '/search?brand=Apple');
    expect(screen.getByText('Rated 4.5 out of 5')).toBeInTheDocument();
    expect(screen.getByTestId('product-price')).toHaveTextContent('$899.99');
    expect(screen.getByText('In stock')).toBeInTheDocument();
  });

  it('W02 AS-32: money follows the currency of the response', () => {
    render(<ProductSummary product={{ ...product, priceMinor: 1999, currency: 'JPY' }} shop={null} />);
    expect(screen.getByTestId('product-price')).toHaveTextContent('¥1,999');
  });

  it('W02 AS-32: "Not rated yet" for a rating of 0', () => {
    render(<ProductSummary product={{ ...product, rating: 0 }} shop={null} />);
    expect(screen.getByText('Not rated yet')).toBeInTheDocument();
    expect(screen.queryByText(/Rated 0/)).toBeNull();
  });

  it('W02 AS-32: Out of stock, and no stock count anywhere', () => {
    render(<ProductSummary product={{ ...product, inStock: false }} shop={null} />);
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
    expect(screen.queryByText(/available|\d+ in stock/i)).toBeNull();
  });

  it('W02 AS-32: the description is text with its line breaks kept, never HTML', () => {
    const { container } = render(<ProductSummary product={product} shop={null} />);
    const description = screen.getByTestId('product-description');
    expect(description.textContent).toBe('Line one\nLine two <b>not bold</b>');
    expect(description).toHaveClass('whitespace-pre-line');
    expect(container.querySelector('b')).toBeNull();
  });

  it('W02 AS-32: tags are links to a search for the tag', () => {
    render(<ProductSummary product={product} shop={null} />);
    expect(screen.getByRole('link', { name: '5g' })).toHaveAttribute('href', '/search?q=5g');
    expect(screen.getByRole('link', { name: 'smart phone' })).toHaveAttribute('href', '/search?q=smart+phone');
  });

  it('W02 AS-35: "Sold by {name}" is text and not a link; it is omitted when the shop is null', () => {
    const { rerender, container } = render(<ProductSummary product={product} shop={shop} />);
    expect(screen.getByText('Sold by Acme <Store>')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Acme/ })).toBeNull();
    expect(container.querySelector('store')).toBeNull();
    rerender(<ProductSummary product={product} shop={null} />);
    expect(screen.queryByText(/Sold by/)).toBeNull();
  });

  it('W02 AS-32: shows none of the fields the public view does not carry', () => {
    render(<ProductSummary product={product} shop={shop} />);
    expect(screen.queryByText(/views?\b/i)).toBeNull();
    expect(screen.queryByText(product.shopId)).toBeNull();
  });

  it('W02 AS-37: the purchase area slot sits between the stock line and the shop line', () => {
    render(
      <ProductSummary product={product} shop={shop}>
        <button>Add to cart</button>
      </ProductSummary>,
    );
    const html = document.body.innerHTML;
    expect(html.indexOf('In stock')).toBeLessThan(html.indexOf('Add to cart'));
    expect(html.indexOf('Add to cart')).toBeLessThan(html.indexOf('Sold by'));
  });
});

describe('productJsonLd', () => {
  it('W02 AS-32: describes the same product with the currency of the response', () => {
    const ld = JSON.parse(productJsonLd(product, { siteUrl: 'https://shop.example.com', imageUrl: 'https://m.example/f.jpg' }));
    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.title,
      brand: { '@type': 'Brand', name: 'Apple' },
      image: ['https://m.example/f.jpg'],
      url: `https://shop.example.com/products/${ID}`,
      offers: { '@type': 'Offer', priceCurrency: 'USD', price: '899.99', availability: 'https://schema.org/InStock' },
    });
  });

  it('W02 AS-32: availability and fraction digits follow the product', () => {
    const ld = JSON.parse(productJsonLd({ ...product, inStock: false, currency: 'JPY', priceMinor: 500 }, { siteUrl: 'https://s.example' }));
    expect(ld.offers).toMatchObject({ priceCurrency: 'JPY', price: '500', availability: 'https://schema.org/OutOfStock' });
    expect(ld.image).toBeUndefined();
  });

  it('W02 AS-72: "<" is escaped so a title cannot close the script', () => {
    const text = productJsonLd({ ...product, title: '</script><script>alert(1)</script>' }, { siteUrl: 'https://s.example' });
    expect(text).not.toContain('<');
    expect(text).toContain('\\u003c/script>');
    expect(JSON.parse(text).name).toBe('</script><script>alert(1)</script>');
  });
});

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProductCard } from '@/components/product/product-card';
import { RailCard } from '@/components/product/rail-card';
import type { CardModel } from '@/lib/product/cards';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';

const base: CardModel = {
  id: ID,
  title: 'iPhone 17',
  brand: 'Apple',
  priceMinor: 89999,
  currency: 'USD',
  rating: 4.5,
  inStock: true,
  imageUrl: 'https://media.example.com/a.jpg',
  href: `/products/${ID}`,
};

describe('ProductCard', () => {
  it('W02 AS-02 rail variant: rank, title, category, price from minor units and currency, one link, no implementation note', () => {
    render(<RailCard {...base} rank={1} category="audio" priceMinor={1999} currency="EUR" />);
    const link = screen.getByRole('link');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(link).toHaveAttribute('href', `/products/${ID}`);
    expect(link).toHaveAccessibleName(/iPhone 17.*€19\.99/);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Audio')).toBeInTheDocument();
    expect(screen.queryByText(/sketch|top-k|SD-/i)).toBeNull();
  });

  it('W02 AS-10: title, brand, rating text, price', () => {
    render(<ProductCard {...base} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', `/products/${ID}`);
    expect(screen.getByText('iPhone 17')).toBeInTheDocument();
    expect(screen.getByText('Apple')).toBeInTheDocument();
    expect(screen.getByText('Rated 4.5 out of 5')).toBeInTheDocument();
    expect(screen.getByText('$899.99')).toBeInTheDocument();
    expect(screen.queryByText('Out of stock')).toBeNull();
    expect(screen.queryByText('Sponsored')).toBeNull();
  });

  it('W02 AS-10: no rating text when the rating is 0 or absent', () => {
    const { rerender } = render(<ProductCard {...base} rating={0} />);
    expect(screen.queryByText(/Rated/)).toBeNull();
    rerender(<ProductCard {...base} rating={undefined} />);
    expect(screen.queryByText(/Rated/)).toBeNull();
  });

  it('W02 AS-10: shows Out of stock', () => {
    render(<ProductCard {...base} inStock={false} />);
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
  });

  it('W02 AS-10: placeholder when imageUrl is null', () => {
    const { container } = render(<ProductCard {...base} imageUrl={null} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('card-image-placeholder')).toBeInTheDocument();
  });

  it('W02 AS-72: a non-https imageUrl is ignored', () => {
    const { container } = render(<ProductCard {...base} imageUrl="http://evil.example/a.jpg" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('card-image-placeholder')).toBeInTheDocument();
    const { container: c2 } = render(<ProductCard {...base} imageUrl="javascript:alert(1)" />);
    expect(c2.querySelector('img')).toBeNull();
  });

  it('W02 AS-10: the image is decorative (empty alt) because the title is in the same link', () => {
    const { container } = render(<ProductCard {...base} />);
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
  });

  it('W02 AS-22: the Sponsored label is text and comes before the title in the link', () => {
    render(<ProductCard {...base} sponsored />);
    const link = screen.getByRole('link');
    expect(link.textContent!.indexOf('Sponsored')).toBeGreaterThanOrEqual(0);
    expect(link.textContent!.indexOf('Sponsored')).toBeLessThan(link.textContent!.indexOf('iPhone 17'));
  });

  it('W02 AS-76: memoised, the same props do not re-render', () => {
    expect((ProductCard as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
    expect((RailCard as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });
});

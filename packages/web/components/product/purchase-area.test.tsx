import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('@/components/add-to-cart-button', () => ({
  AddToCartButton: ({ productId, category, disabled }: { productId: string; category?: string; disabled?: boolean }) => (
    <button type="button" disabled={disabled} data-product={productId} data-category={category}>
      {disabled ? 'Out of stock' : 'Add to cart'}
    </button>
  ),
}));

import { PurchaseArea } from '@/components/product/purchase-area';

type Entry = { isIntersecting: boolean };
let notify: (entry: Entry) => void = () => {};
const OriginalObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  class FakeObserver {
    constructor(private callback: (entries: Entry[]) => void) {}
    // Next's <Link> observes too; only the observer of the purchase area is the one the tests drive.
    observe(element: Element) {
      if (element.getAttribute('data-testid') === 'purchase-area') notify = (entry) => this.callback([entry]);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  globalThis.IntersectionObserver = OriginalObserver;
});

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const props = { productId: ID, category: 'phones', inStock: true, priceMinor: 89999, currency: 'USD' };

describe('PurchaseArea', () => {
  it('W02 AS-37: holds Add to cart then Chat with seller, in that order', () => {
    render(<PurchaseArea {...props} />);
    const main = screen.getByTestId('purchase-area');
    const html = main.innerHTML;
    expect(html.indexOf('Add to cart')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('Add to cart')).toBeLessThan(html.indexOf('Chat with seller'));
    expect(screen.getByRole('link', { name: 'Chat with seller' })).toHaveAttribute('href', `/chat?product=${ID}`);
  });

  it('W02 AS-37: the add-to-cart control receives the product id, its category and disabled', () => {
    render(<PurchaseArea {...props} />);
    const button = screen.getAllByRole('button', { name: 'Add to cart' })[0]!;
    expect(button).toHaveAttribute('data-product', ID);
    expect(button).toHaveAttribute('data-category', 'phones');
    expect(button).toBeEnabled();
  });

  it('W02 AS-37: out of stock disables Add to cart and labels it', () => {
    render(<PurchaseArea {...props} inStock={false} />);
    const button = screen.getAllByRole('button', { name: 'Out of stock' })[0]!;
    expect(button).toBeDisabled();
  });

  it('W02 AS-37: the bottom bar repeats price and Add to cart only while the main area is out of view', () => {
    render(<PurchaseArea {...props} />);
    expect(screen.queryByTestId('mobile-purchase-bar')).toBeNull();
    act(() => notify({ isIntersecting: false }));
    const bar = screen.getByTestId('mobile-purchase-bar');
    expect(bar).toHaveTextContent('$899.99');
    expect(bar.querySelector('button')).toHaveAttribute('data-product', ID);
    expect(bar).toHaveClass('sm:hidden');
    act(() => notify({ isIntersecting: true }));
    expect(screen.queryByTestId('mobile-purchase-bar')).toBeNull();
  });

  it('W02 AS-37: the bottom bar does not cover the element that gets focus', () => {
    render(
      <>
        <PurchaseArea {...props} />
        <button>Elsewhere</button>
      </>,
    );
    act(() => notify({ isIntersecting: false }));
    const target = screen.getByRole('button', { name: 'Elsewhere' });
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 700, bottom: 760, left: 0, right: 100, width: 100, height: 60, x: 0, y: 700, toJSON() {} });
    vi.spyOn(screen.getByTestId('mobile-purchase-bar'), 'getBoundingClientRect').mockReturnValue({ top: 740, bottom: 800, left: 0, right: 390, width: 390, height: 60, x: 0, y: 740, toJSON() {} });
    act(() => target.focus());
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
  });

  it('W02 AS-37: where the bar is hidden by CSS (a zero-size box) a focused element is never scrolled', () => {
    render(
      <>
        <PurchaseArea {...props} />
        <button>Elsewhere</button>
      </>,
    );
    act(() => notify({ isIntersecting: false }));
    const target = screen.getByRole('button', { name: 'Elsewhere' });
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 300, bottom: 340, left: 0, right: 100, width: 100, height: 40, x: 0, y: 300, toJSON() {} });
    vi.spyOn(screen.getByTestId('mobile-purchase-bar'), 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
    act(() => target.focus());
    expect(scroll).not.toHaveBeenCalled();
  });

  it('W02 AS-37: an element that is not under the bar is not scrolled', () => {
    render(
      <>
        <PurchaseArea {...props} />
        <button>Elsewhere</button>
      </>,
    );
    act(() => notify({ isIntersecting: false }));
    const target = screen.getByRole('button', { name: 'Elsewhere' });
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 300, bottom: 340, left: 0, right: 100, width: 100, height: 40, x: 0, y: 300, toJSON() {} });
    vi.spyOn(screen.getByTestId('mobile-purchase-bar'), 'getBoundingClientRect').mockReturnValue({ top: 740, bottom: 800, left: 0, right: 390, width: 390, height: 60, x: 0, y: 740, toJSON() {} });
    act(() => target.focus());
    expect(scroll).not.toHaveBeenCalled();
  });
});

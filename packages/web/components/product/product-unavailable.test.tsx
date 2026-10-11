import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }) }));

import { ProductUnavailable } from '@/components/product/product-unavailable';

describe('ProductUnavailable', () => {
  it('W02 AS-33: not found says so, links to search, and marks the page noindex', () => {
    const { container } = render(<ProductUnavailable state="not-found" />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText("We couldn't find that product.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Search products' })).toHaveAttribute('href', '/search');
    expect(container.ownerDocument.querySelector('meta[name="robots"][content="noindex"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('W02 AS-33: unavailable has the copy, Try again and the reference', async () => {
    const user = userEvent.setup();
    render(<ProductUnavailable state="unavailable" requestId="req-42" />);
    expect(screen.getByText("This product page couldn't be loaded right now. Try again.")).toBeInTheDocument();
    expect(screen.getByText('Reference: req-42')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('W02 AS-33: unavailable without a reference shows none', () => {
    render(<ProductUnavailable state="unavailable" />);
    expect(screen.queryByText(/Reference:/)).toBeNull();
  });

  it('W02 AS-33: rate limited shows the wait', () => {
    render(<ProductUnavailable state="rate-limited" retryAfterSeconds={30} />);
    expect(screen.getByText('Too many requests. Try again in 30 seconds.')).toBeInTheDocument();
  });

  it('W02 AS-33: rate limited without a header says to try later', () => {
    render(<ProductUnavailable state="rate-limited" />);
    expect(screen.getByText(/Try again later\./)).toBeInTheDocument();
  });

  it('W02 AS-33: offline shows the offline copy and Try again', () => {
    render(<ProductUnavailable state="offline" />);
    expect(screen.getByText('You appear to be offline. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('W02 AS-33: server detail and title are never shown (only the catalogue copy)', () => {
    render(<ProductUnavailable state="unavailable" requestId="r" />);
    expect(screen.queryByText(/Server (title|detail)/)).toBeNull();
  });
});

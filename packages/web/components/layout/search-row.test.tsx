import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchRow } from './search-row';

let mockPathname = '/products/x';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/search/search-box', () => ({
  SearchBox: () => <input type="search" aria-label="Search products" />,
}));

describe('W07 mobile search row (AS-03)', () => {
  beforeEach(() => {
    mockPathname = '/products/x';
  });

  it.each(['/', '/search'])('W07 AS-03: no button on %s (the page has its own box)', (path) => {
    mockPathname = path;
    const { container } = render(<SearchRow />);
    expect(container).toBeEmptyDOMElement();
  });

  it('W07 AS-03: a button named "Search" opens the row and the input receives focus', async () => {
    render(<SearchRow />);
    const button = screen.getByRole('button', { name: 'Search' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('searchbox', { name: 'Search products' })).toHaveFocus();
  });

  it('W07 AS-03: Escape closes the row and returns focus to the button', async () => {
    render(<SearchRow />);
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toHaveFocus();
  });

  it('W07 AS-03: "Close search" closes the row and returns focus to the button', async () => {
    render(<SearchRow />);
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toHaveFocus();
  });

  it('W07 AS-03: the row closes when the route changes', async () => {
    const { rerender } = render(<SearchRow />);
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    mockPathname = '/privacy';
    rerender(<SearchRow />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('W07 AS-03: no keyboard shortcut is advertised', async () => {
    const { container } = render(<SearchRow />);
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(container.querySelector('kbd')).toBeNull();
    expect(document.body.textContent).not.toMatch(/⌘|Ctrl\s*\+?\s*K/i);
  });
});

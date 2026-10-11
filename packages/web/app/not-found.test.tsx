import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import NotFound, { metadata } from './not-found';

describe('W07 not-found page (AS-09)', () => {
  it('W07 AS-09: heading, text and both actions', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText("We couldn't find the page you were looking for. It may have moved, or the address may be wrong.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Browse products' })).toHaveAttribute('href', '/search');
  });

  it('W07 AS-09: title "Page not found" (the layout template adds " · Marketplace"); noindex is added by Next.js and checked in the journey', () => {
    expect(metadata.title).toBe('Page not found');
  });

  it.each([
    '/<script>alert(1)</script>',
    '/%3Cimg%20src=x%20onerror=alert(1)%3E',
    '/products/../../etc/passwd',
    `/${'a'.repeat(5000)}`,
    '/invites/secret-token-123',
  ])('W07 AS-09: the visited path is never rendered (%.40s)', (path) => {
    window.history.pushState({}, '', path);
    const { container } = render(<NotFound />);
    const html = container.innerHTML + document.title;
    expect(html).not.toContain('script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('passwd');
    expect(html).not.toContain('secret-token');
    expect(html).not.toContain('aaaaaaaaaa');
  });
});

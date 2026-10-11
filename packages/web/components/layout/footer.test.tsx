import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '@/lib/config-parse';

/** The footer reads the parsed configuration; each case parses its own environment, so the real `https:` rule applies. */
async function renderFooter(sourceCodeUrl?: string) {
  vi.resetModules();
  vi.doMock('@/lib/config', () => ({
    config: parseConfig({ NODE_ENV: 'production', SITE_URL: 'https://shop.example.com', SOURCE_CODE_URL: sourceCodeUrl }, { warn: () => {} }),
  }));
  const { Footer } = await import('./footer');
  return render(<Footer />);
}

describe('W07 footer (AS-08)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-06-15T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('@/lib/config');
  });

  it('W07 AS-08: contentinfo with the sentence and the current year', async () => {
    await renderFooter();
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText('Marketplace is a portfolio project: no real goods are sold and no real payments are taken.')).toBeInTheDocument();
    expect(within(footer).getByText('© 2031 Marketplace')).toBeInTheDocument();
  });

  it('W07 AS-08: a navigation named "Footer" with Browse, API docs, Terms and Privacy', async () => {
    await renderFooter();
    const nav = screen.getByRole('navigation', { name: 'Footer' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Browse', '/search'],
      ['API docs', '/developers/docs'],
      ['Terms', '/terms'],
      ['Privacy', '/privacy'],
    ]);
  });

  it('W07 AS-08: every link is at least a 44 px target on a phone', async () => {
    await renderFooter();
    for (const link of within(screen.getByRole('navigation', { name: 'Footer' })).getAllByRole('link')) expect(link.className).toContain('min-h-11');
  });

  it.each([
    ['unset', undefined, false],
    ['http:', 'http://git.example.com/repo', false],
    ['javascript:', 'javascript:alert(1)', false],
    ['not a url', 'repo', false],
    ['https:', 'https://git.example.com/repo', true],
  ])('W07 AS-08: Source code link when the configured address is %s -> shown: %s', async (_label, address, shown) => {
    await renderFooter(address);
    const link = screen.queryByRole('link', { name: /Source code/ });
    if (!shown) {
      expect(link).not.toBeInTheDocument();
    } else {
      expect(link).toHaveAttribute('href', address);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveAccessibleName('Source code (opens in a new tab)');
    }
  });
});

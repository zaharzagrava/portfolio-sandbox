import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: 'font-geist-sans' }),
  Geist_Mono: () => ({ variable: 'font-geist-mono' }),
}));
vi.mock('@/lib/config', () => ({ config: { siteUrl: 'https://shop.example.com' } }));
vi.mock('@/components/layout/nonce-providers', () => ({ NonceProviders: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/auth/session-bootstrap', () => ({ SessionBootstrap: () => null }));
vi.mock('@/components/layout/navbar', () => ({ Navbar: () => <header data-testid="header">header</header> }));
vi.mock('@/components/layout/footer', () => ({ Footer: () => <footer data-testid="footer">footer</footer> }));
vi.mock('@/components/layout/route-focus', () => ({ RouteFocus: () => null }));

import RootLayout, { metadata, viewport } from './layout';

const documentOf = () =>
  new DOMParser().parseFromString(
    `<!DOCTYPE html>${renderToStaticMarkup(
      <RootLayout>
        <h1>Page</h1>
      </RootLayout>,
    )}`,
    'text/html',
  );

describe('W07 root layout (AS-07, FR-001)', () => {
  it('W07 AS-07: exactly one banner, one main and one contentinfo', () => {
    const doc = documentOf();
    expect(doc.querySelectorAll('header')).toHaveLength(1);
    expect(doc.querySelectorAll('main')).toHaveLength(1);
    expect(doc.querySelectorAll('footer')).toHaveLength(1);
  });

  it('W07 AS-07: main is #main-content, focusable by script (tabIndex -1), and holds the page', () => {
    const main = documentOf().querySelector('main')!;
    expect(main.id).toBe('main-content');
    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(main.querySelector('h1')?.textContent).toBe('Page');
  });

  it('W07 AS-07: order is skip link, header, main, footer', () => {
    const doc = documentOf();
    const names = Array.from(doc.body.querySelectorAll('a[href="#main-content"], header, main, footer')).map((el) => el.tagName.toLowerCase());
    expect(names).toEqual(['a', 'header', 'main', 'footer']);
    expect(doc.body.querySelector('a[href="#main-content"]')!.textContent).toBe('Skip to main content');
  });

  it('W07 AS-07: lang is en and the assistant sheet is no longer mounted at layout level', () => {
    const doc = documentOf();
    expect(doc.documentElement.getAttribute('lang')).toBe('en');
    expect(doc.body.textContent).not.toContain('AI Shopping Assistant');
  });

  it('W07 AS-34: title template "{Page} · Marketplace", default "Marketplace", metadataBase from the site address', () => {
    expect(metadata.title).toEqual({ default: 'Marketplace', template: '%s · Marketplace' });
    expect(String(metadata.metadataBase)).toBe('https://shop.example.com/');
  });

  it('W07 AS-31: the viewport lets the page scale (no zoom lock)', () => {
    expect(viewport).toMatchObject({ width: 'device-width', initialScale: 1 });
    expect(JSON.stringify(viewport)).not.toMatch(/maximumScale|userScalable/);
  });
});

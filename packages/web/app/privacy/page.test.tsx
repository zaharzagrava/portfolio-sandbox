import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PrivacyPage, { metadata } from './page';

describe('W07 privacy page (AS-23, AS-26)', () => {
  it('W07 AS-23: one h1 "Privacy policy", a "Last updated" constant and the five sections with anchor ids', () => {
    render(<PrivacyPage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeInTheDocument();
    expect(screen.getByText(/^Last updated: \d{4}-\d{2}-\d{2}$/)).toBeInTheDocument();
    const h2s = screen.getAllByRole('heading', { level: 2 });
    expect(h2s.map((heading) => heading.textContent)).toEqual(['What we store', 'Cookies and browser storage', 'Who receives data', 'Your choices', 'Contact']);
    for (const heading of h2s) expect(heading.id).toBeTruthy();
  });

  it('W07 AS-23: says what is stored, and about the processors and deletion', () => {
    render(<PrivacyPage />);
    for (const text of [/email address/i, /password hash/i, /network address/i, /carts, orders/i, /chat messages/i, /photos and videos/i]) {
      expect(screen.getByText(text, { exact: false })).toBeInTheDocument();
    }
    expect(screen.getByText(/payment provider in the sandbox/i)).toBeInTheDocument();
    expect(screen.getByText(/map tile host/i)).toBeInTheDocument();
    expect(screen.getByText(/no sale of data|do not sell/i)).toBeInTheDocument();
    expect(screen.getByText(/Accounts and content in this showcase may be deleted at any time; ask via the address below/)).toBeInTheDocument();
    expect(screen.getByText(/sign out on all devices/i)).toBeInTheDocument();
  });

  it('W07 AS-23: describes the session, CSRF and anonymous-id cookies and the theme key, and no third-party tracking', () => {
    render(<PrivacyPage />);
    expect(screen.getAllByText(/HttpOnly/).length).toBeGreaterThan(0);
    expect(screen.getByText(/readable by the page, not a credential/i)).toBeInTheDocument();
    expect(screen.getByText(/one year/i)).toBeInTheDocument();
    expect(screen.getByText(/Global Privacy Control/)).toBeInTheDocument();
    expect(screen.getByText(/no advertising or third-party tracking cookies/i)).toBeInTheDocument();
  });

  it('W07 AS-25: has a labelled "On this page" navigation linking every section', () => {
    render(<PrivacyPage />);
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    expect(nav.querySelectorAll('a')).toHaveLength(5);
  });

  it('W07 AS-26: the title is the page name (the layout adds "· Marketplace") and the page is indexable', () => {
    expect(metadata.title).toBe('Privacy policy');
    expect(metadata).not.toHaveProperty('robots');
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TermsPage, { metadata } from './page';

describe('W07 terms page (AS-24)', () => {
  it('W07 AS-24: one h1, a "Last updated" date and the seven sections with anchor ids', () => {
    render(<TermsPage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeInTheDocument();
    expect(screen.getByText(/^Last updated: \d{4}-\d{2}-\d{2}$/)).toBeInTheDocument();
    const names = ['What this is', 'Accounts', 'Acceptable use', 'The API', 'No warranty', 'Changes', 'Contact'];
    const h2s = screen.getAllByRole('heading', { level: 2 });
    expect(h2s.map((h) => h.textContent)).toEqual(names);
    for (const h of h2s) expect(h.id).toBeTruthy();
  });

  it('W07 AS-24: states the portfolio nature, deletion, rate limits and key scopes', () => {
    render(<TermsPage />);
    expect(screen.getByText(/no real goods are sold and no real payments are taken/i)).toBeInTheDocument();
    expect(screen.getByText(/may be deleted at any time/i)).toBeInTheDocument();
    expect(screen.getByText(/Rate limits apply/)).toBeInTheDocument();
    expect(screen.getByText(/within their scopes/)).toBeInTheDocument();
  });

  it('W07 AS-24: title comes from the layout template and the page is indexable', () => {
    expect(metadata.title).toBe('Terms of service');
    expect(metadata).not.toHaveProperty('robots');
  });
});

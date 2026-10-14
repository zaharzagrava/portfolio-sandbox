import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./reference', () => ({ Reference: () => <section aria-label="reference stand-in" /> }));

import DocsPage, { metadata } from './page';

describe('W07 developer docs page (AS-27)', () => {
  it('W07 AS-27: one h1 "API documentation", the static sections, and no second header or main', () => {
    const { container } = render(<DocsPage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'API documentation' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Authentication', 'Errors', 'Deprecation']);
    expect(container.querySelector('main, header')).toBeNull();
    expect(screen.getByLabelText('reference stand-in')).toBeInTheDocument();
  });

  it('W07 AS-27: the introduction links to the seller dashboard and names where keys are created', () => {
    render(<DocsPage />);
    expect(screen.getByRole('link', { name: /seller dashboard/i })).toHaveAttribute('href', '/dashboard/seller');
    expect(screen.getByText(/Developers → API keys/)).toBeInTheDocument();
  });

  it('W07 AS-27: the errors section lists the problem fields and links RFC 9457; the deprecation section names the headers', () => {
    render(<DocsPage />);
    for (const field of ['type', 'title', 'status', 'detail', 'instance', 'requestId', 'code', 'errors']) {
      expect(screen.getByText(field, { selector: 'code' }), field).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: /RFC 9457/ })).toHaveAttribute('href', 'https://www.rfc-editor.org/rfc/rfc9457');
    expect(screen.getAllByText('Retry-After', { selector: 'code' }).length).toBeGreaterThan(0);
    expect(screen.getByText('Deprecation', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('Sunset', { selector: 'code' })).toBeInTheDocument();
  });

  it('W07 AS-26: the title is the page name and the page holds no absolute API address', () => {
    expect(metadata.title).toBe('API documentation');
    const { container } = render(<DocsPage />);
    expect(container.innerHTML).not.toMatch(/localhost|127\.0\.0\.1|:3000|:8000/);
  });
});

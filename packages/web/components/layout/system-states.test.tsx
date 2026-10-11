import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccessDeniedState, NotFoundState } from './system-states';

describe('W07 NotFoundState (AS-09)', () => {
  it('W07 AS-09: default copy and actions', () => {
    render(<NotFoundState />);
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText("We couldn't find the page you were looking for. It may have moved, or the address may be wrong.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Browse products' })).toHaveAttribute('href', '/search');
  });

  it('W07 AS-09: a capability can supply its own title, description and actions', () => {
    render(<NotFoundState title="Product not found" description="It may have been removed." actions={<a href="/search?q=x">Search again</a>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Product not found' })).toBeInTheDocument();
    expect(screen.getByText('It may have been removed.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Search again' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Browse products' })).not.toBeInTheDocument();
  });
});

describe('W07 AccessDeniedState (AS-13)', () => {
  it('W07 AS-13: copy and a way home', () => {
    render(<AccessDeniedState />);
    expect(screen.getByRole('heading', { level: 1, name: "You don't have access" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
  });
});

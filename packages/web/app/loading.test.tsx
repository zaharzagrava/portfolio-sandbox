import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Loading from './loading';

describe('W07 loading (AS-12)', () => {
  it('W07 AS-12: the region is busy and holds a single "Loading…" status', () => {
    const { container } = render(<Loading />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('W07 AS-12: nothing is visible before 150 ms (the reveal is delayed in CSS, so it also holds in streamed HTML)', () => {
    const { container } = render(<Loading />);
    const reveal = container.querySelector('[data-reveal-delay]') as HTMLElement;
    expect(reveal).not.toBeNull();
    expect(reveal.style.animationDelay).toBe('150ms');
    expect(reveal.style.animationFillMode).toBe('both');
    expect(reveal.className).toContain('loading-reveal');
  });

  it('W07 AS-12: the placeholder is page-shaped', () => {
    const { container } = render(<Loading />);
    expect(container.querySelector('[data-variant="detail"]')).not.toBeNull();
  });
});

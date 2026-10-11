import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageSkeleton } from './page-skeleton';

describe('W07 PageSkeleton (AS-12)', () => {
  it.each(['detail', 'list', 'form'] as const)('W07 AS-12: variant %s renders a shaped, decorative placeholder', (variant) => {
    const { container } = render(<PageSkeleton variant={variant} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('data-variant', variant);
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(2);
  });

  it('W07 AS-12: the variants have different shapes', () => {
    const count = (variant: 'detail' | 'list' | 'form') => render(<PageSkeleton variant={variant} />).container.querySelectorAll('[data-slot="skeleton"]').length;
    expect(new Set([count('detail'), count('list'), count('form')]).size).toBe(3);
  });
});

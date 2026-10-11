import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SkipLink } from './skip-link';

describe('W07 skip link (AS-07)', () => {
  it('W07 AS-07: a link "Skip to main content" to #main-content, hidden until focused', () => {
    render(<SkipLink />);
    const link = screen.getByRole('link', { name: 'Skip to main content' });
    expect(link).toHaveAttribute('href', '#main-content');
    expect(link.className).toContain('sr-only');
    expect(link.className).toContain('focus:not-sr-only');
  });

  it('W07 AS-07: it is the first focusable element: the first Tab lands on it', async () => {
    render(
      <>
        <SkipLink />
        <header>
          <button type="button">Home</button>
        </header>
      </>,
    );
    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
  });
});

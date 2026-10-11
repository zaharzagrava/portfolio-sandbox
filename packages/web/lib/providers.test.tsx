import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Providers } from './providers';

describe('W07 providers (AS-14, AS-15)', () => {
  it('W07 AS-15: the children come first, then the one toast area and the offline status region', () => {
    render(
      <Providers>
        <p>child</p>
      </Providers>,
    );
    const child = screen.getByText('child');
    const status = screen.getByRole('status');
    expect(child.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelectorAll('section[aria-label^="Notifications"]')).toHaveLength(1);
  });
});

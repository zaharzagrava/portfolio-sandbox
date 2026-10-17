import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShopStatusBanner } from './shop-status-banner';

describe('W04 ShopStatusBanner', () => {
  it('W04 AS-86: nothing for an active shop', () => {
    const { container } = render(<ShopStatusBanner shop={{ status: 'ACTIVE' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('W04 AS-86: a suspended shop says it is read-only', () => {
    render(<ShopStatusBanner shop={{ status: 'SUSPENDED' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('This shop is suspended. You can view data but not make changes.');
  });

  it.each(['DELETING', 'DELETED'])('W04 AS-86: a %s shop says it is being closed', (status) => {
    render(<ShopStatusBanner shop={{ status }} />);
    expect(screen.getByRole('status')).toHaveTextContent('This shop is being closed. You can view data but not make changes.');
  });

  it('W04 AS-86: the state is text, not colour alone, and the banner is a labelled region for the page', () => {
    render(<ShopStatusBanner shop={{ status: 'SUSPENDED' }} />);
    expect(screen.getByRole('status')).toHaveAccessibleName('Shop status');
  });
});

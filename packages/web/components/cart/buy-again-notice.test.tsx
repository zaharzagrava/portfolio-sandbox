import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/lib/query-keys';
import { BuyAgainNotice } from './buy-again-notice';

function renderNotice(titles?: string[]) {
  const client = new QueryClient();
  if (titles) client.setQueryData(queryKeys.cart.buyAgainFailures(), titles);
  render(
    <QueryClientProvider client={client}>
      <BuyAgainNotice />
    </QueryClientProvider>,
  );
  return client;
}

describe('Buy again notice on the cart page', () => {
  it('W03 AS-59: lists the lines that could not be added as text, in an alert', () => {
    renderNotice(['Headphones', '<b>Speaker</b>']);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't add: Headphones, <b>Speaker</b>.");
    expect(alert.querySelector('b')).toBeNull();
  });

  it('W03 AS-59: absent when nothing failed or nothing ran', () => {
    renderNotice([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('W03 AS-59: Dismiss removes it', async () => {
    const client = renderNotice(['Headphones']);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(client.getQueryData(queryKeys.cart.buyAgainFailures())).toEqual([]);
  });
});

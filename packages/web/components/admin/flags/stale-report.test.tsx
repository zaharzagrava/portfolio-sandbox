import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { FLAGS_URL, staleFixture } from '@/lib/test/flag-fixtures';
import { navigation, navigationMock, renderAdmin, resetNavigation } from './test-utils';

vi.mock('next/navigation', () => navigationMock());

import { StaleReport } from './stale-report';

beforeEach(resetNavigation);

const items = [
  { key: 'old-flag', owner: 'a@x.io', status: 'enabled' as const, expiresAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', evaluations: 120, expired: true, reason: 'expired' as const },
  { key: 'quiet-flag', owner: 'b@x.io', status: 'disabled' as const, expiresAt: null, createdAt: '2026-02-01T00:00:00.000Z', evaluations: 0, expired: false, reason: 'unused' as const },
];

describe('StaleReport', () => {
  it('W06 AS-45: a captioned table with key links, reason, UTC dates, evaluations and the approximate-counts note', async () => {
    server.use(http.get(`${FLAGS_URL}/stale`, () => HttpResponse.json(staleFixture(items, 14))));
    renderAdmin(<StaleReport days={14} />);
    const table = await screen.findByRole('table', { name: 'Stale flags' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Key', 'Owner', 'Status', 'Reason', 'Expires', 'Created', 'Evaluations']);
    expect(within(table).getByRole('link', { name: 'old-flag' })).toHaveAttribute('href', '/admin/feature-flags/old-flag');
    expect(within(table).getByText('Expired')).toBeInTheDocument();
    expect(within(table).getByText('Not evaluated in the last 14 days')).toBeInTheDocument();
    expect(within(table).getByText('2026-09-01 00:00 UTC')).toBeInTheDocument();
    expect(within(table).getByText('120')).toBeInTheDocument();
    expect(screen.getByText(/counts are approximate/i)).toBeInTheDocument();
    expect(screen.getByText(/never changes how a flag evaluates/i)).toBeInTheDocument();
  });

  it('W06 AS-45: items are shown in the order returned', async () => {
    server.use(http.get(`${FLAGS_URL}/stale`, () => HttpResponse.json(staleFixture([items[1]!, items[0]!], 14))));
    renderAdmin(<StaleReport days={14} />);
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['quiet-flag', 'old-flag']);
  });

  it('W06 AS-46: the window select offers 7, 14, 21 and 30, shows the URL window and changes the URL', async () => {
    let days = '';
    server.use(http.get(`${FLAGS_URL}/stale`, ({ request }) => ((days = new URL(request.url).searchParams.get('days') ?? ''), HttpResponse.json(staleFixture(items, Number(days))))));
    const { user } = renderAdmin(<StaleReport days={7} />);
    await screen.findByRole('table');
    expect(days).toBe('7');
    const select = screen.getByRole('combobox', { name: 'Window' });
    expect(select).toHaveValue('7');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['7 days', '14 days', '21 days', '30 days']);
    await user.selectOptions(select, '30');
    expect(navigation.router.push).toHaveBeenCalledWith('/admin/feature-flags?tab=stale&days=30');
    await user.selectOptions(select, '14');
    expect(navigation.router.push).toHaveBeenLastCalledWith('/admin/feature-flags?tab=stale');
  });

  it('W06 AS-46: an empty report is good news and names the window', async () => {
    server.use(http.get(`${FLAGS_URL}/stale`, () => HttpResponse.json(staleFixture([], 21))));
    renderAdmin(<StaleReport days={21} />);
    expect(await screen.findByText('No stale flags. Nothing has expired and every flag has been evaluated in the last 21 days.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('W06 AS-63: a skeleton while loading', async () => {
    server.use(http.get(`${FLAGS_URL}/stale`, () => new Promise(() => undefined)));
    const { container } = renderAdmin(<StaleReport days={14} />);
    await waitFor(() => expect(container.querySelector('[data-skeleton="stale"]')).toBeInTheDocument());
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { FLAGS_URL, flagFixture, flagPageFixture, problemBody } from '@/lib/test/flag-fixtures';
import { navigationMock, newClient, renderAdmin, resetNavigation } from './test-utils';

vi.mock('next/navigation', () => navigationMock());
vi.mock('sonner', () => ({ toast: vi.fn(), Toaster: () => null }));

import { FlagList } from './flag-list';

beforeEach(resetNavigation);

const flags = [
  flagFixture({ key: 'alpha-flag', status: 'enabled', enabled: true, description: 'First', owner: 'a@x.io', clientSide: true, expiresAt: '2026-12-01T00:00:00.000Z' }),
  flagFixture({ key: 'beta-flag', status: 'killed', description: '', owner: 'b@x.io' }),
  flagFixture({ key: 'gamma-flag', status: 'archived', owner: 'c@x.io' }),
];

describe('FlagList', () => {
  it('W06 AS-01: a captioned table with the columns, text badges, key links, UTC times, no counters', async () => {
    server.use(http.get(FLAGS_URL, () => HttpResponse.json(flagPageFixture(flags))));
    renderAdmin(<FlagList status="all" />);
    const table = await screen.findByRole('table', { name: 'Feature flags' });
    const headers = within(table).getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toEqual(['Key', 'Description', 'Status', 'Owner', 'Client-side', 'Expires', 'Updated', 'Actions']);
    for (const header of within(table).getAllByRole('columnheader')) expect(header).toHaveAttribute('scope', 'col');
    expect(within(table).getByRole('link', { name: 'alpha-flag' })).toHaveAttribute('href', '/admin/feature-flags/alpha-flag');
    const row = within(table).getByRole('link', { name: 'alpha-flag' }).closest('tr')!;
    expect(within(row).getByText('Enabled')).toBeInTheDocument();
    expect(within(row).getByText('Yes')).toBeInTheDocument();
    expect(within(row).getByText('2026-12-01 00:00 UTC')).toBeInTheDocument();
    expect(within(row).getByText('2026-10-02 10:00 UTC')).toBeInTheDocument();
    expect(within(table).getByText('Killed')).toBeInTheDocument();
    expect(screen.queryByText(/evaluations/i)).not.toBeInTheDocument();
  });

  it('W06 AS-01: the list is requested with the default page size (no limit)', async () => {
    let url = '';
    server.use(http.get(FLAGS_URL, ({ request }) => ((url = request.url), HttpResponse.json(flagPageFixture(flags)))));
    renderAdmin(<FlagList status="all" />);
    await screen.findByRole('table');
    expect(new URL(url).searchParams.has('limit')).toBe(false);
  });

  it('W06 AS-02: the status tabs are links carrying the status, the selected one is marked, an unknown status shows All active', async () => {
    server.use(http.get(FLAGS_URL, () => HttpResponse.json(flagPageFixture(flags))));
    renderAdmin(<FlagList status="killed" />);
    await screen.findByRole('table');
    const tabs = within(screen.getByRole('tablist', { name: 'Status' })).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['All active', 'Enabled', 'Disabled', 'Killed', 'Archived']);
    expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual([
      '/admin/feature-flags',
      '/admin/feature-flags?status=enabled',
      '/admin/feature-flags?status=disabled',
      '/admin/feature-flags?status=killed',
      '/admin/feature-flags?status=archived',
    ]);
    expect(screen.getByRole('tab', { name: 'Killed' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'All active' })).toHaveAttribute('aria-selected', 'false');
  });

  it('W06 AS-03: the Archived tab asks for includeArchived and offers only Open on a row', async () => {
    let url = '';
    server.use(http.get(FLAGS_URL, ({ request }) => ((url = request.url), HttpResponse.json(flagPageFixture([flags[2]!])))));
    const { user } = renderAdmin(<FlagList status="archived" />);
    await screen.findByRole('table');
    expect(new URL(url).searchParams.get('includeArchived')).toBe('true');
    expect(within(screen.getByRole('table')).getByText('Archived')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions for gamma-flag' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Open']);
  });

  it('W06 AS-04: Next page carries nextCursor, First page appears with a cursor, the count is of the page', async () => {
    server.use(http.get(FLAGS_URL, () => HttpResponse.json(flagPageFixture(flags.slice(0, 2), 'cursor-2'))));
    renderAdmin(<FlagList status="enabled" cursor="cursor-1" />);
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', '/admin/feature-flags?status=enabled&cursor=cursor-2');
    expect(screen.getByRole('link', { name: 'First page' })).toHaveAttribute('href', '/admin/feature-flags?status=enabled');
    expect(screen.getByText('Showing 2 flags')).toBeInTheDocument();
  });

  it('W06 AS-04: no Next page without a cursor from the API, no First page without one in the URL', async () => {
    server.use(http.get(FLAGS_URL, () => HttpResponse.json(flagPageFixture([flags[0]!]))));
    renderAdmin(<FlagList status="all" />);
    await screen.findByRole('table');
    expect(screen.queryByRole('link', { name: 'Next page' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'First page' })).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1 flag')).toBeInTheDocument();
  });

  it('W06 AS-05: no flags at all and no flags of a status are two different messages', async () => {
    server.use(http.get(FLAGS_URL, () => HttpResponse.json(flagPageFixture([]))));
    const first = renderAdmin(<FlagList status="all" />);
    expect(await screen.findByText('No feature flags yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New flag' })).toHaveAttribute('href', '/admin/feature-flags/new');
    first.unmount();
    renderAdmin(<FlagList status="killed" />);
    expect(await screen.findByText('No killed flags.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Show all active flags' })).toHaveAttribute('href', '/admin/feature-flags');
    expect(screen.queryByText('No feature flags yet.')).not.toBeInTheDocument();
  });

  it('W06 AS-06: while loading, a skeleton shows (no spinner, no "Loading")', () => {
    server.use(http.get(FLAGS_URL, async () => new Promise(() => undefined)));
    const { container } = renderAdmin(<FlagList status="all" />);
    expect(container.querySelector('[data-skeleton="flag-list"]')).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it('W06 AS-06: server data in the cache makes the first paint have rows', async () => {
    server.use(http.get(FLAGS_URL, () => HttpResponse.json(flagPageFixture(flags))));
    renderAdmin(<FlagList status="all" initialData={flagPageFixture(flags)} />);
    expect(screen.getByRole('table', { name: 'Feature flags' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
  });

  it('W06 AS-07: a failed list is an alert with a reference and Try again; Try again reads again', async () => {
    let calls = 0;
    server.use(
      http.get(FLAGS_URL, () => {
        calls += 1;
        // the hook retries a 5xx once, so the first two reads fail
        return calls <= 2 ? HttpResponse.json(problemBody(503, 'unavailable', { requestId: 'req-503' }), { status: 503 }) : HttpResponse.json(flagPageFixture(flags));
      }),
    );
    const { user } = renderAdmin(<FlagList status="all" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side.');
    expect(alert).toHaveTextContent('Reference: req-503');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('W06 AS-07: a failed background refetch keeps the rows and says so', async () => {
    const client = newClient();
    client.setQueryData(queryKeys.admin.flags.list({ status: 'all' }), flagPageFixture(flags));
    server.use(http.get(FLAGS_URL, () => HttpResponse.json(problemBody(500, 'internal_error'), { status: 500 })));
    renderAdmin(<FlagList status="all" />, { client });
    expect(await screen.findByText("Couldn't refresh. Showing the last loaded list.")).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'alpha-flag' })).toBeInTheDocument();
  });

  it('W06 AS-48: a 403 replaces the content with the no-access panel', async () => {
    server.use(http.get(FLAGS_URL, () => HttpResponse.json(problemBody(403, 'permission_denied'), { status: 403 })));
    renderAdmin(<FlagList status="all" />);
    expect(await screen.findByRole('heading', { name: "You don't have access to this area." })).toBeInTheDocument();
  });

  it('W06 AS-64: markup in a description or owner is shown as text', async () => {
    const hostile = flagFixture({ key: 'xss-flag', description: '<img src=x onerror="alert(1)">', owner: '<b>boss</b>' });
    server.use(http.get(FLAGS_URL, () => HttpResponse.json(flagPageFixture([hostile]))));
    const { container } = renderAdmin(<FlagList status="all" />);
    expect(await screen.findByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
    expect(screen.getByText('<b>boss</b>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('W06 AS-65: rows keep their identity by flag key; a removed row sends focus to the next row\'s link', async () => {
    const client = newClient();
    client.setQueryData(queryKeys.admin.flags.list({ status: 'all' }), flagPageFixture(flags));
    server.use(http.get(FLAGS_URL, () => HttpResponse.json(flagPageFixture(flags))));
    const { rerenderAdmin } = renderAdmin(<FlagList status="all" />, { client });
    const alpha = screen.getByRole('link', { name: 'alpha-flag' });
    alpha.focus();
    expect(alpha).toHaveFocus();
    await waitFor(() => expect(screen.getByRole('link', { name: 'alpha-flag' })).toBeInTheDocument());
    client.setQueryData(queryKeys.admin.flags.list({ status: 'all' }), flagPageFixture(flags.slice(1)));
    rerenderAdmin(<FlagList status="all" />);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'alpha-flag' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('link', { name: 'beta-flag' })).toHaveFocus());
  });

  it('W06 AS-58: header cells have scope="col" and the table has a caption', async () => {
    server.use(http.get(FLAGS_URL, () => HttpResponse.json(flagPageFixture(flags))));
    renderAdmin(<FlagList status="all" />);
    const table = await screen.findByRole('table');
    expect(table.querySelector('caption')).toHaveTextContent('Feature flags');
    expect(within(table).getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['alpha-flag', 'beta-flag', 'gamma-flag']);
  });
});

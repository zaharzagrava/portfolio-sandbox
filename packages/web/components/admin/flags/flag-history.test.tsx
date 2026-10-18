import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { auditFixture, auditPageFixture, flagFixture, FLAGS_URL, problemBody } from '@/lib/test/flag-fixtures';
import { ADMIN_USER, navigationMock, renderAdmin, resetNavigation, stubClipboard } from './test-utils';

vi.mock('next/navigation', () => navigationMock());

import { FlagHistory } from './flag-history';

beforeEach(resetNavigation);

const HISTORY = `${FLAGS_URL}/new-checkout/history`;
const created = flagFixture({ status: 'disabled', version: 1 });
const updated = flagFixture({ status: 'enabled', enabled: true, version: 2, description: 'Checkout v3' });
const killed = flagFixture({ status: 'killed', version: 3 });

const entries = [
  auditFixture({ id: '30', action: 'kill', actorId: ADMIN_USER.id, requestId: 'req-30', at: '2026-10-03T12:00:00.000Z', before: updated as never, after: killed as never }),
  auditFixture({ id: '20', action: 'update', actorId: 'someone-else-uuid', requestId: 'req-20', at: '2026-10-02T12:00:00.000Z', before: created as never, after: updated as never }),
  auditFixture({ id: '10', action: 'create', actorId: ADMIN_USER.id, requestId: null, at: '2026-10-01T12:00:00.000Z', before: null, after: created as never }),
];

describe('FlagHistory', () => {
  it('W06 AS-40: the entries are listed newest first with label, UTC time, actor ("You" or the id with Copy) and request id with Copy', async () => {
    server.use(http.get(HISTORY, () => HttpResponse.json(auditPageFixture(entries))));
    renderAdmin(<FlagHistory flagKey="new-checkout" />);
    const list = await screen.findByRole('list', { name: 'Change history' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => within(item).getByTestId('action').textContent)).toEqual(['Killed', 'Updated', 'Created']);
    const [first, second] = items;
    expect(within(first!).getByText('2026-10-03 12:00 UTC').closest('time')).toHaveAttribute('datetime', '2026-10-03T12:00:00.000Z');
    expect(within(first!).getByText('You')).toBeInTheDocument();
    expect(within(second!).getByText('someone-else-uuid')).toHaveClass('font-mono');
    expect(within(second!).getByRole('button', { name: 'Copy actor id' })).toBeInTheDocument();
    expect(within(second!).getByText('req-20')).toBeInTheDocument();
    expect(within(second!).getByRole('button', { name: 'Copy request id' })).toBeInTheDocument();
    expect(within(items[2]!).queryByRole('button', { name: 'Copy request id' })).not.toBeInTheDocument();
  });

  it('W06 AS-40: Copy puts the id on the clipboard and says so', async () => {
    server.use(http.get(HISTORY, () => HttpResponse.json(auditPageFixture(entries))));
    const { user } = renderAdmin(<FlagHistory flagKey="new-checkout" />);
    const write = stubClipboard(); // after userEvent.setup(), which installs its own clipboard
    const second = (await screen.findAllByRole('listitem'))[1]!;
    await user.click(within(second).getByRole('button', { name: 'Copy request id' }));
    expect(write).toHaveBeenCalledWith('req-20');
    expect(await screen.findByText('Copied to clipboard')).toBeInTheDocument();
  });

  it('W06 AS-41: Show changes expands to the fields that differ; a create entry says "Created with"', async () => {
    server.use(http.get(HISTORY, () => HttpResponse.json(auditPageFixture(entries))));
    const { user } = renderAdmin(<FlagHistory flagKey="new-checkout" />);
    const items = await screen.findAllByRole('listitem');
    const button = within(items[0]!).getByRole('button', { name: 'Show changes' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(within(items[0]!).getByText('Status: Enabled → Killed')).toBeInTheDocument();
    await user.click(within(items[1]!).getByRole('button', { name: 'Show changes' }));
    expect(within(items[1]!).getByText('Description: Checkout v2 → Checkout v3')).toBeInTheDocument();
    await user.click(within(items[2]!).getByRole('button', { name: 'Show changes' }));
    expect(within(items[2]!).getByText('Created with')).toBeInTheDocument();
    expect(within(items[2]!).getByText('Status: Disabled')).toBeInTheDocument();
  });

  it('W06 AS-41: an entry without a visible difference says so', async () => {
    const same = auditFixture({ id: '5', action: 'update', before: created as never, after: { ...created, version: 9 } as never });
    server.use(http.get(HISTORY, () => HttpResponse.json(auditPageFixture([same]))));
    const { user } = renderAdmin(<FlagHistory flagKey="new-checkout" />);
    await user.click(await screen.findByRole('button', { name: 'Show changes' }));
    expect(screen.getByText('No visible changes')).toBeInTheDocument();
  });

  it('W06 AS-64: markup in an audit value is shown as text', async () => {
    const hostile = auditFixture({ id: '6', action: 'update', before: created as never, after: { ...created, description: '<img src=x onerror=alert(1)>' } as never });
    server.use(http.get(HISTORY, () => HttpResponse.json(auditPageFixture([hostile]))));
    const { user, container } = renderAdmin(<FlagHistory flagKey="new-checkout" />);
    await user.click(await screen.findByRole('button', { name: 'Show changes' }));
    expect(screen.getByText('Description: Checkout v2 → <img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('W06 AS-42: Older carries the cursor, Newest appears with a cursor in the URL', async () => {
    let seen = '';
    server.use(http.get(HISTORY, ({ request }) => ((seen = new URL(request.url).searchParams.get('cursor') ?? ''), HttpResponse.json(auditPageFixture(entries.slice(0, 2), 'older-1')))));
    renderAdmin(<FlagHistory flagKey="new-checkout" cursor="c-now" />);
    expect(await screen.findByRole('link', { name: 'Older' })).toHaveAttribute('href', '/admin/feature-flags/new-checkout?tab=history&cursor=older-1');
    expect(screen.getByRole('link', { name: 'Newest' })).toHaveAttribute('href', '/admin/feature-flags/new-checkout?tab=history');
    expect(seen).toBe('c-now');
  });

  it('W06 AS-42: no Older without nextCursor, no Newest without a cursor', async () => {
    server.use(http.get(HISTORY, () => HttpResponse.json(auditPageFixture(entries))));
    renderAdmin(<FlagHistory flagKey="new-checkout" />);
    await screen.findByRole('list', { name: 'Change history' });
    expect(screen.queryByRole('link', { name: 'Older' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Newest' })).not.toBeInTheDocument();
  });

  it('W06 AS-42: a bad cursor is a panel that leads to the newest changes', async () => {
    server.use(http.get(HISTORY, () => HttpResponse.json(problemBody(400, 'invalid_cursor'), { status: 400 })));
    renderAdmin(<FlagHistory flagKey="new-checkout" cursor="garbage" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That page link is no longer valid.');
    expect(within(alert).getByRole('link', { name: 'Go to the newest changes' })).toHaveAttribute('href', '/admin/feature-flags/new-checkout?tab=history');
  });

  it('W06 AS-43: an unknown key is the not-found message', async () => {
    server.use(http.get(HISTORY, () => HttpResponse.json(problemBody(404, 'flag_not_found'), { status: 404 })));
    renderAdmin(<FlagHistory flagKey="new-checkout" />);
    expect(await screen.findByText("We couldn't find that flag.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All flags' })).toBeInTheDocument();
  });

  it('W06 AS-43: an archived flag history is just a history (the archive entry is listed)', async () => {
    const archive = auditFixture({ id: '99', action: 'archive', before: killed as never, after: flagFixture({ status: 'archived', version: 4 }) as never });
    server.use(http.get(HISTORY, () => HttpResponse.json(auditPageFixture([archive]))));
    renderAdmin(<FlagHistory flagKey="new-checkout" />);
    expect(await screen.findByTestId('action')).toHaveTextContent('Archived');
  });

  it('W06 AS-44: opening the tab refetches (the new entry is there without reloading the page)', async () => {
    let calls = 0;
    server.use(http.get(HISTORY, () => (calls += 1, HttpResponse.json(auditPageFixture(calls === 1 ? entries.slice(1) : entries)))));
    const { client, rerenderAdmin } = renderAdmin(<FlagHistory flagKey="new-checkout" />);
    await waitFor(() => expect(screen.getAllByTestId('action')).toHaveLength(2));
    await client.invalidateQueries({ queryKey: ['admin', 'flags'] });
    rerenderAdmin(<FlagHistory flagKey="new-checkout" />);
    await waitFor(() => expect(screen.getAllByTestId('action')).toHaveLength(3));
  });

  it('W06 AS-63: a skeleton while loading, no spinner', async () => {
    server.use(http.get(HISTORY, () => new Promise(() => undefined)));
    const { container } = renderAdmin(<FlagHistory flagKey="new-checkout" />);
    await waitFor(() => expect(container.querySelector('[data-skeleton="history"]')).toBeInTheDocument());
  });
});

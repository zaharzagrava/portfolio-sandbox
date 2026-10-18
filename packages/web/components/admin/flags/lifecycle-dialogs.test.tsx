import { screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { FLAGS_URL, flagFixture, problemBody } from '@/lib/test/flag-fixtures';
import { navigationMock, renderAdmin, resetNavigation } from './test-utils';

vi.mock('next/navigation', () => navigationMock());
const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { useFlag } from '@/hooks/use-admin-flags';
import { LifecycleDialog } from './lifecycle-dialogs';

beforeEach(() => {
  resetNavigation();
  toast.mockReset();
});

const KEY = 'new-checkout';
const onClose = vi.fn();
const open = (action: 'kill' | 'restore' | 'archive') => renderAdmin(<LifecycleDialog flagKey={KEY} action={action} offVariant="off" onClose={onClose} />);

describe('lifecycle dialogs', () => {
  beforeEach(() => onClose.mockReset());

  it('W06 AS-32: the kill dialog names the off variant, focuses Cancel and sends one POST …/kill', async () => {
    const posts: string[] = [];
    server.use(
      http.post(`${FLAGS_URL}/${KEY}/kill`, async ({ request }) => {
        posts.push(request.url);
        await delay(80);
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${FLAGS_URL}/${KEY}`, () => HttpResponse.json(flagFixture({ status: 'killed' }))),
    );
    const { user } = open('kill');
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(within(dialog).getByText(`Kill ${KEY}?`)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      'Every evaluation will serve the off variant (off) regardless of targeting. Rules and rollouts are kept. The change reaches services within seconds and browsers on their next fetch. Restoring is a separate step.',
    );
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.dblClick(within(dialog).getByRole('button', { name: 'Kill flag' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts).toHaveLength(1);
    expect(toast).toHaveBeenCalledWith(`Flag ${KEY} killed.`);
  });

  it('W06 AS-32: the confirm button says "Killing…" while the request runs', async () => {
    let release!: () => void;
    server.use(
      http.post(`${FLAGS_URL}/${KEY}/kill`, async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${FLAGS_URL}/${KEY}`, () => HttpResponse.json(flagFixture({ status: 'killed' }))),
    );
    const { user } = open('kill');
    await user.click(await screen.findByRole('button', { name: 'Kill flag' }));
    const busy = await screen.findByRole('button', { name: 'Killing…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('W06 AS-36: restore explains that the flag becomes disabled and toasts the result', async () => {
    server.use(http.post(`${FLAGS_URL}/${KEY}/restore`, () => new HttpResponse(null, { status: 204 })), http.get(`${FLAGS_URL}/${KEY}`, () => HttpResponse.json(flagFixture())));
    const { user } = open('restore');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`Restore ${KEY}?`)).toBeInTheDocument();
    expect(dialog).toHaveTextContent('It becomes disabled: still off for everyone. You can enable it afterwards by saving.');
    await user.click(within(dialog).getByRole('button', { name: 'Restore flag' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(`Flag ${KEY} restored. It is disabled.`));
  });

  it('W06 AS-37: archive explains what it means and toasts the result', async () => {
    server.use(http.post(`${FLAGS_URL}/${KEY}/archive`, () => new HttpResponse(null, { status: 204 })), http.get(`${FLAGS_URL}/${KEY}`, () => HttpResponse.json(flagFixture({ status: 'archived' }))));
    const { user } = open('archive');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('It leaves the active list and stops evaluating (services get their fallback). Its key can never be reused. Its history stays readable.');
    await user.click(within(dialog).getByRole('button', { name: 'Archive flag' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(`Flag ${KEY} archived.`));
  });

  it('W06 AS-38: invalid_transition keeps the dialog open with the plain explanation and refetches the flag', async () => {
    let refetched = 0;
    server.use(
      http.post(`${FLAGS_URL}/${KEY}/archive`, () => HttpResponse.json(problemBody(409, 'invalid_transition', { currentStatus: 'enabled' }), { status: 409 })),
      http.get(`${FLAGS_URL}/${KEY}`, () => (refetched += 1, HttpResponse.json(flagFixture({ status: 'enabled', enabled: true })))),
    );
    // The page behind the dialog has the flag open (an active detail query), which the dialog asks to read again.
    const Probe = () => <p>{useFlag(KEY).data?.status ?? 'loading'}</p>;
    const { user } = renderAdmin(
      <>
        <Probe />
        <LifecycleDialog flagKey={KEY} action="archive" offVariant="off" onClose={onClose} />
      </>,
    );
    await waitFor(() => expect(refetched).toBe(1));
    await user.click(await screen.findByRole('button', { name: 'Archive flag' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`${KEY} is now enabled, so that isn't possible. The page has been refreshed.`);
    await waitFor(() => expect(refetched).toBe(2));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Archive flag' })).toBeEnabled();
  });

  it('W06 AS-38: flag_archived on an action reads "was archived and can\'t be changed"', async () => {
    server.use(http.post(`${FLAGS_URL}/${KEY}/kill`, () => HttpResponse.json(problemBody(409, 'flag_archived'), { status: 409 })));
    const { user } = open('kill');
    await user.click(await screen.findByRole('button', { name: 'Kill flag' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`${KEY} was archived and can't be changed.`);
  });

  it('W06 AS-39: a 5xx leaves the dialog open with the generic copy, a reference, and the buttons usable again', async () => {
    server.use(http.post(`${FLAGS_URL}/${KEY}/kill`, () => HttpResponse.json(problemBody(500, 'internal_error', { requestId: 'req-500' }), { status: 500 })));
    const { user } = open('kill');
    await user.click(await screen.findByRole('button', { name: 'Kill flag' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side.');
    expect(alert).toHaveTextContent('Reference: req-500');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('W06 AS-57: Cancel closes the dialog', async () => {
    const { user } = open('kill');
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { FLAGS_URL, flagFixture, problemBody } from '@/lib/test/flag-fixtures';
import { ADMIN_USER, navigation, navigationMock, renderAdmin, resetNavigation } from './test-utils';

vi.mock('next/navigation', () => navigationMock());
const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { CreateFlagForm } from './create-flag-form';

beforeEach(() => {
  resetNavigation();
  toast.mockReset();
});

const fill = async (user: ReturnType<typeof renderAdmin>['user'], key: string) => {
  await user.type(screen.getByLabelText('Key'), key);
};

describe('CreateFlagForm', () => {
  it('W06 AS-09: sends the starter definition with expectedVersion 0, goes to the editor and says the flag is disabled', async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.put(`${FLAGS_URL}/smoke-1`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(flagFixture({ key: 'smoke-1', version: 1 }), { status: 201 });
      }),
    );
    const { user } = renderAdmin(<CreateFlagForm />);
    await fill(user, 'smoke-1');
    await user.click(screen.getByRole('button', { name: 'Create flag' }));
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith('/admin/feature-flags/smoke-1'));
    expect(toast).toHaveBeenCalledWith('Flag smoke-1 created. It is disabled.');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      expectedVersion: 0,
      owner: ADMIN_USER.email,
      enabled: false,
      variants: [
        { key: 'off', value: false },
        { key: 'on', value: true },
      ],
      defaultVariant: 'off',
      offVariant: 'off',
      rules: [],
      bucketBy: 'userId',
      clientSide: false,
      expiresAt: null,
    });
  });

  it('W06 AS-10: Owner starts as the viewer\'s e-mail and is editable; Description is optional; the key carries the contract hint', async () => {
    renderAdmin(<CreateFlagForm />);
    expect(screen.getByLabelText('Owner')).toHaveValue(ADMIN_USER.email);
    expect(screen.getByLabelText(/Description/)).not.toBeRequired();
    const key = screen.getByLabelText('Key');
    expect(key).toHaveAttribute('maxlength', '64');
    expect(key).toHaveAttribute('pattern', '^[a-z0-9][a-z0-9-]{1,63}$');
    expect(screen.getByText('Lowercase letters, digits and hyphens. It cannot be changed later.')).toBeInTheDocument();
    expect(key).toHaveAccessibleDescription('Lowercase letters, digits and hyphens. It cannot be changed later.');
  });

  it('W06 AS-10: a description, when typed, is sent', async () => {
    let body: Record<string, unknown> = {};
    server.use(http.put(`${FLAGS_URL}/with-text`, async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json(flagFixture({ key: 'with-text', version: 1 }), { status: 201 }))));
    const { user } = renderAdmin(<CreateFlagForm />);
    await fill(user, 'with-text');
    await user.type(screen.getByLabelText(/Description/), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Create flag' }));
    await waitFor(() => expect(body.description).toBe('Hello'));
  });

  it('W06 AS-15: an empty key or owner stops before sending and says what to enter, focus on the first', async () => {
    let sent = 0;
    server.use(http.put(`${FLAGS_URL}/:key`, () => (sent += 1, HttpResponse.json(flagFixture()))));
    const { user } = renderAdmin(<CreateFlagForm />);
    await user.clear(screen.getByLabelText('Owner'));
    await user.click(screen.getByRole('button', { name: 'Create flag' }));
    expect(screen.getByText('Enter a key.')).toBeInTheDocument();
    expect(screen.getByText('Enter an owner.')).toBeInTheDocument();
    expect(screen.getByLabelText('Key')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Key')).toHaveFocus();
    expect(sent).toBe(0);
  });

  it('W06 AS-12: an existing key is explained under the key with a link to it, focus on the key', async () => {
    server.use(http.put(`${FLAGS_URL}/taken-one`, () => HttpResponse.json(problemBody(409, 'version_conflict', { currentVersion: 1 }), { status: 409 })));
    const { user } = renderAdmin(<CreateFlagForm />);
    await fill(user, 'taken-one');
    await user.click(screen.getByRole('button', { name: 'Create flag' }));
    expect(await screen.findByText('A flag with this key already exists.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open taken-one' })).toHaveAttribute('href', '/admin/feature-flags/taken-one');
    expect(screen.getByLabelText('Key')).toHaveFocus();
    expect(screen.getByLabelText('Key')).toHaveAttribute('aria-invalid', 'true');
  });

  it('W06 AS-12: a key of an archived flag is reserved', async () => {
    server.use(http.put(`${FLAGS_URL}/old-one`, () => HttpResponse.json(problemBody(409, 'flag_archived'), { status: 409 })));
    const { user } = renderAdmin(<CreateFlagForm />);
    await fill(user, 'old-one');
    await user.click(screen.getByRole('button', { name: 'Create flag' }));
    expect(await screen.findByText("This key belonged to an archived flag and can't be reused.")).toBeInTheDocument();
    expect(screen.getByLabelText('Key')).toHaveFocus();
  });

  it('W06 AS-13: the flag limit is explained with a link to the stale report', async () => {
    server.use(http.put(`${FLAGS_URL}/one-more`, () => HttpResponse.json(problemBody(422, 'flag_limit_reached'), { status: 422 })));
    const { user } = renderAdmin(<CreateFlagForm />);
    await fill(user, 'one-more');
    await user.click(screen.getByRole('button', { name: 'Create flag' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The limit of 500 active flags is reached. Archive a flag you no longer need, then try again.');
    expect(within(alert).getByRole('link', { name: 'Review stale flags' })).toHaveAttribute('href', '/admin/feature-flags?tab=stale');
  });

  it('W06 AS-14: semantic problems are listed in a summary and under their fields, focus on the first', async () => {
    server.use(
      http.put(`${FLAGS_URL}/bad-owner`, () =>
        HttpResponse.json(
          problemBody(422, 'flag_definition_invalid', { errors: [{ path: 'owner', code: 'owner_too_long' }, { path: 'rules[0].rollout', code: 'weights_sum_invalid', sum: 9000 }] }),
          { status: 422 },
        ),
      ),
    );
    const { user } = renderAdmin(<CreateFlagForm />);
    await fill(user, 'bad-owner');
    await user.click(screen.getByRole('button', { name: 'Create flag' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'Owner: Owner can be at most 100 characters.' })).toHaveAttribute('href', '#flag-owner');
    expect(within(alert).getByText(/Weights must add up to 100%/)).toBeInTheDocument();
    const owner = screen.getByLabelText('Owner');
    expect(owner).toHaveAttribute('aria-invalid', 'true');
    expect(owner).toHaveAccessibleDescription('Owner can be at most 100 characters.');
    expect(owner).toHaveFocus();
  });

  it('W06 AS-15: validation_failed shows each entry under the field it names', async () => {
    server.use(http.put(`${FLAGS_URL}/odd-one`, () => HttpResponse.json(problemBody(400, 'validation_failed', { errors: [{ field: 'description', code: 'invalid' }] }), { status: 400 })));
    const { user } = renderAdmin(<CreateFlagForm />);
    await fill(user, 'odd-one');
    await user.click(screen.getByRole('button', { name: 'Create flag' }));
    expect(await screen.findByLabelText(/Description/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/Description/)).toHaveFocus();
  });

  it('W06 AS-16: pressing twice creates one flag; the button says "Creating…", is busy and the form takes no edits', async () => {
    let puts = 0;
    server.use(
      http.put(`${FLAGS_URL}/once-only`, async () => {
        puts += 1;
        await delay(120);
        return HttpResponse.json(flagFixture({ key: 'once-only', version: 1 }), { status: 201 });
      }),
    );
    const { user } = renderAdmin(<CreateFlagForm />);
    await fill(user, 'once-only');
    await user.dblClick(screen.getByRole('button', { name: 'Create flag' }));
    const busy = await screen.findByRole('button', { name: 'Creating…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('Key')).toBeDisabled();
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalled());
    expect(puts).toBe(1);
  });

  it('W06 AS-50: a rate limit shows the countdown and disables the button until it ends', async () => {
    server.use(http.put(`${FLAGS_URL}/slow-down`, () => HttpResponse.json(problemBody(429, 'rate_limited'), { status: 429, headers: { 'Retry-After': '30' } })));
    const { user } = renderAdmin(<CreateFlagForm />);
    await fill(user, 'slow-down');
    await user.click(screen.getByRole('button', { name: 'Create flag' }));
    expect(await screen.findByText('Too many requests. Try again in 30 seconds.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create flag' })).toBeDisabled();
  });
});

import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { isDraftDirty, sessionEndedDescription } from '@/lib/admin/flags/dirty';
import { endSession, rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { flagFixture, FLAGS_URL, problemBody } from '@/lib/test/flag-fixtures';
import type { Flag } from '@marketplace-sandbox/contracts';
import { navigation, navigationMock, newClient, renderAdmin, resetNavigation, stubClipboard } from './test-utils';

vi.mock('next/navigation', () => navigationMock());
const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { FlagEditor } from './flag-editor';

const KEY = 'new-checkout';
const URL = `${FLAGS_URL}/${KEY}`;

let server_flag: Flag;
let puts: Record<string, unknown>[];

beforeEach(() => {
  resetNavigation();
  toast.mockReset();
  puts = [];
  server_flag = flagFixture();
  rearmSessionEnd();
  server.use(http.get(URL, () => HttpResponse.json(server_flag)));
});
afterEach(() => {
  setSessionEndHandler(null);
  rearmSessionEnd();
});

/** Opens the editor with the flag already in the cache (what the server prefetch hands over) and waits for the form. */
async function open(flag: Flag = flagFixture()) {
  server_flag = flag;
  const client = newClient();
  client.setQueryData(queryKeys.admin.flags.detail(KEY), flag);
  const view = renderAdmin(<FlagEditor flagKey={KEY} />, { client });
  await screen.findByRole('heading', { level: 1, name: KEY });
  return view;
}

/** A PUT handler that records bodies and answers with `answer(body)`. */
const answerPut = (answer: (body: Record<string, unknown>) => Response | Promise<Response>) =>
  server.use(
    http.put(URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      puts.push(body);
      return answer(body);
    }),
  );
/** The save is applied: later reads of the flag return it too. */
const ok = (patch: Partial<Flag> = {}) => {
  server_flag = flagFixture({ version: 4, ...patch });
  return HttpResponse.json(server_flag);
};

const save = () => screen.getByRole('button', { name: 'Save changes' });
const edit = async (user: Awaited<ReturnType<typeof open>>['user'], text = ' more') => {
  await user.type(screen.getByLabelText('Description'), text);
};

describe('FlagEditor: open and edit', () => {
  it('W06 AS-17: the header shows the key as h1, the badge, the version and UTC times; the sections follow in order; the help card explains evaluation', async () => {
    await open(flagFixture({ status: 'enabled', enabled: true }));
    const header = screen.getByRole('banner', { name: '' }).tagName ? screen.getByRole('heading', { level: 1 }).closest('header')! : document.body;
    expect(within(header).getByText('Enabled')).toBeInTheDocument();
    expect(header).toHaveTextContent('Version 3');
    expect(within(header).getByText('2026-10-01 10:00 UTC')).toBeInTheDocument();
    expect(within(header).getByText('2026-10-02 10:00 UTC')).toBeInTheDocument();
    const order = ['Basics', 'Variants', 'Default and off variants', 'Targeting rules'].map((name) => {
      const el = screen.getByText(name, { selector: 'legend, h2' });
      return el.compareDocumentPosition.bind(el);
    });
    expect(order[0]!(screen.getByText('Variants', { selector: 'legend' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('How a flag is evaluated')).toBeInTheDocument();
    expect(screen.getByText('Killed or disabled: everyone gets the off variant. Otherwise the first rule that matches decides. If no rule matches, the default variant is served.')).toBeInTheDocument();
  });

  it('W06 AS-11: a disabled flag carries the dark notice', async () => {
    await open();
    expect(screen.getByText(/This flag is disabled: everyone gets the off variant\./)).toBeInTheDocument();
  });

  it('W06 AS-18: saving sends the whole definition with the loaded version, shows "Saved." and the new version', async () => {
    answerPut(() => ok({ description: 'Checkout v2 more' }));
    const { user } = await open();
    await edit(user);
    await user.click(screen.getByLabelText('Client-side'));
    await user.click(save());
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ expectedVersion: 3, description: 'Checkout v2 more', clientSide: true, enabled: false, owner: 'admin@marketplace.local' });
    expect(Object.keys(puts[0]!).sort()).toEqual(['bucketBy', 'clientSide', 'defaultVariant', 'description', 'enabled', 'expectedVersion', 'expiresAt', 'offVariant', 'owner', 'rules', 'variants']);
    expect(screen.getByRole('heading', { level: 1 }).closest('header')).toHaveTextContent('Version 4');
  });

  it('W06 AS-24: Enabled is a switch with a description, bound to the draft; it takes effect only on Save', async () => {
    answerPut(() => ok({ status: 'enabled', enabled: true }));
    const { user } = await open();
    const toggle = screen.getByRole('switch', { name: 'Enabled' });
    expect(toggle).toHaveAccessibleDescription('When off, everyone gets the off variant.');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(puts).toHaveLength(0);
    await user.click(save());
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ enabled: true });
    expect(await screen.findByText('Enabled', { selector: '.inline-flex' })).toBeInTheDocument();
  });

  it('W06 AS-25: with no changes Save and Discard are disabled; with edits both are enabled and "Unsaved changes" shows', async () => {
    const { user } = await open();
    expect(save()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    await edit(user);
    expect(save()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(isDraftDirty()).toBe(true);
  });

  it('W06 AS-25: Discard asks first (Keep editing is focused) and then restores the loaded definition', async () => {
    const { user } = await open();
    await edit(user);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Description')).toHaveValue('Checkout v2 more');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue('Checkout v2'));
    expect(save()).toBeDisabled();
  });

  it('W06 AS-25: following a link while dirty asks first; Discard changes goes there; closing the tab is guarded by the browser prompt', async () => {
    const { user } = await open();
    const link = document.createElement('a');
    link.href = '/admin/feature-flags';
    link.textContent = 'Back to flags';
    document.body.appendChild(link);
    await user.click(link);
    expect(navigation.router.push).not.toHaveBeenCalled();
    await edit(user);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await user.click(link);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith('/admin/feature-flags'));
    link.remove();
  });

  it('W06 AS-25: a clean form is not guarded', async () => {
    await open();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it('W06 AS-26: a successful save resets the form to the server\'s answer and disables Save again', async () => {
    answerPut(() => ok({ description: 'Normalised by the server' }));
    const { user } = await open();
    await edit(user);
    await user.click(save());
    await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue('Normalised by the server'));
    expect(save()).toBeDisabled();
    expect(isDraftDirty()).toBe(false);
  });

  it('W06 AS-29: ticking Client-side shows the notice, tied to the checkbox', async () => {
    const { user } = await open();
    await user.click(screen.getByLabelText('Client-side'));
    expect(screen.getByLabelText('Client-side')).toHaveAccessibleDescription("Browsers can read this flag's name, variant and value. Never put secrets in a client-side flag.");
  });

  it('W06 AS-17: Expires says that expiry is only a reminder', async () => {
    await open();
    expect(screen.getByLabelText(/Expires/)).toHaveAccessibleDescription('Expiry is a reminder only. An expired flag keeps working until you change or archive it.');
  });

  it('W06 AS-28: a background refetch updates the header but never the draft', async () => {
    const { user, client } = await open();
    await edit(user);
    client.setQueryData(queryKeys.admin.flags.detail(KEY), flagFixture({ version: 5, description: 'someone else' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).closest('header')).toHaveTextContent('Version 5'));
    expect(screen.getByLabelText('Description')).toHaveValue('Checkout v2 more');
  });
});

describe('FlagEditor: failures', () => {
  it('W06 AS-30: JSON and number syntax errors stop the save, name the fields, list them in a summary and focus the first', async () => {
    const { user } = await open(
      flagFixture({ variants: [{ key: 'off', value: false }, { key: 'conf', value: { a: 1 } }, { key: 'limit', value: 5 }], defaultVariant: 'off', offVariant: 'off' }),
    );
    fireEvent.change(document.getElementById('variant-1-value')!, { target: { value: '{nope' } });
    fireEvent.change(document.getElementById('variant-2-value')!, { target: { value: 'abc' } });
    await user.click(save());
    expect(puts).toHaveLength(0);
    expect(document.getElementById('variant-1-value')).toHaveAccessibleDescription('Enter valid JSON.');
    expect(document.getElementById('variant-2-value')).toHaveAccessibleDescription('Enter a number.');
    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('link', { name: 'Variant 2 value: Enter valid JSON.' })).toHaveAttribute('href', '#variant-1-value');
    expect(within(alert).getByRole('link', { name: 'Variant 3 value: Enter a number.' })).toBeInTheDocument();
    expect(document.getElementById('variant-1-value')).toHaveFocus();
  });

  it('W06 AS-27: a lost response keeps the draft, says nothing is confirmed, and Try again re-sends the same body and version', async () => {
    let attempt = 0;
    server.use(
      http.put(URL, async ({ request }) => {
        puts.push((await request.json()) as Record<string, unknown>);
        attempt += 1;
        // The first attempt may have been applied: the second is an equal definition, answered 200 as a no-op.
        return attempt === 1 ? HttpResponse.error() : HttpResponse.json(flagFixture({ description: 'Checkout v2 more', version: 3 }));
      }),
    );
    const { user } = await open();
    await edit(user);
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't reach the server. Your changes haven't been confirmed. Check your connection and try again.");
    expect(screen.getByLabelText('Description')).toHaveValue('Checkout v2 more');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(puts).toHaveLength(2);
    expect(puts[1]).toEqual(puts[0]);
    expect(puts[1]!.expectedVersion).toBe(3);
  });

  it('W06 AS-28: version_conflict is a banner with the current version; Save is disabled until the latest is loaded', async () => {
    answerPut(() => HttpResponse.json(problemBody(409, 'version_conflict', { currentVersion: 5 }), { status: 409 }));
    const { user } = await open();
    await edit(user);
    await user.click(save());
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(`${KEY} was changed by someone else (now version 5). Your changes haven't been saved.`);
    expect(save()).toBeDisabled();
    expect(save()).toHaveAccessibleDescription('Load the latest version before saving.');
    expect(screen.getByLabelText('Description')).toHaveValue('Checkout v2 more');
    await user.click(within(banner).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText(/was changed by someone else/)).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(screen.getByLabelText('Description')).toHaveValue('Checkout v2 more');
  });

  it('W06 AS-28: Load latest asks to discard, then replaces the form with the server\'s definition', async () => {
    answerPut(() => HttpResponse.json(problemBody(409, 'version_conflict', { currentVersion: 5 }), { status: 409 }));
    const { user } = await open();
    await edit(user);
    await user.click(save());
    server_flag = flagFixture({ version: 5, description: 'Their change' });
    await user.click(await screen.findByRole('button', { name: 'Load latest' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Discard unsaved changes?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue('Their change'));
    expect(screen.queryByText(/was changed by someone else/)).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    await user.type(screen.getByLabelText('Description'), '!');
    expect(save()).toBeEnabled();
  });

  it('W06 AS-31: the flag disappearing between open and save is an alert and the draft is kept', async () => {
    answerPut(() => HttpResponse.json(problemBody(404, 'flag_not_found'), { status: 404 }));
    const { user } = await open();
    await edit(user);
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't find that flag.");
    expect(screen.getByLabelText('Description')).toHaveValue('Checkout v2 more');
  });

  it('W06 AS-31: an unknown flag on open is the not-found message with a way back', async () => {
    server.use(http.get(URL, () => HttpResponse.json(problemBody(404, 'flag_not_found'), { status: 404 })));
    renderAdmin(<FlagEditor flagKey={KEY} />);
    expect(await screen.findByRole('heading', { name: "We couldn't find that flag." })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All flags' })).toHaveAttribute('href', '/admin/feature-flags');
  });

  it('W06 AS-48: a 403 on save replaces the content with the no-access panel', async () => {
    answerPut(() => HttpResponse.json(problemBody(403, 'permission_denied'), { status: 403 }));
    const { user } = await open();
    await edit(user);
    await user.click(save());
    expect(await screen.findByRole('heading', { name: "You don't have access to this area." })).toBeInTheDocument();
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
  });

  it('W06 AS-49: a 401 runs the session-ended flow once, and the dirty draft is reported to it', async () => {
    const ended = vi.fn();
    setSessionEndHandler(ended);
    answerPut(() => HttpResponse.json(problemBody(401, 'session_expired'), { status: 401 }));
    const { user } = await open();
    await edit(user);
    expect(sessionEndedDescription()).toBe('Your unsaved edits are lost. Copy them first if you need them.');
    await user.click(save());
    await screen.findByText('Your session ended. Sign in again to continue.');
    endSession();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('W06 AS-49: with a clean form the session-ended toast carries no sentence about edits', async () => {
    await open();
    expect(sessionEndedDescription()).toBeUndefined();
  });

  it('W06 AS-50: a rate limit counts down, disables Save, keeps the draft and enables Save again at 0', async () => {
    answerPut(() => HttpResponse.json(problemBody(429, 'rate_limited'), { status: 429, headers: { 'Retry-After': '1' } }));
    const { user } = await open();
    await edit(user);
    await user.click(save());
    expect(await screen.findByText('Too many requests. Try again in 1 second.')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(screen.getByLabelText('Description')).toHaveValue('Checkout v2 more');
    await waitFor(() => expect(screen.getAllByText('You can try again now.').length).toBeGreaterThan(0), { timeout: 3000 });
    await waitFor(() => expect(save()).toBeEnabled());
  });

  it('W06 AS-51: a 5xx is generic with a reference and Copy; a body that is not problem+json is generic without one', async () => {
    answerPut(() => HttpResponse.json(problemBody(500, 'internal_error', { requestId: 'req-9' }), { status: 500 }));
    const { user } = await open();
    const write = stubClipboard();
    await edit(user);
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side.');
    expect(alert).not.toHaveTextContent('Server detail');
    expect(alert).toHaveTextContent('Reference: req-9');
    await user.click(within(alert).getByRole('button', { name: 'Copy reference' }));
    expect(write).toHaveBeenCalledWith('req-9');
    answerPut(() => new HttpResponse('<html>bad gateway</html>', { status: 502 }));
    await user.click(save());
    await waitFor(() => expect(screen.getByRole('alert')).not.toHaveTextContent('Reference:'));
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on our side.');
  });

  it('W06 AS-53: a rejected CSRF check says reload and does not discard the draft', async () => {
    answerPut(() => HttpResponse.json(problemBody(403, 'csrf_invalid'), { status: 403 }));
    const { user } = await open();
    await edit(user);
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't verify this request. Reload the page and try again.");
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('Checkout v2 more');
  });

  it('W06 AS-14: flag_definition_invalid lists every problem, marks each field and focuses the first', async () => {
    answerPut(() =>
      HttpResponse.json(problemBody(422, 'flag_definition_invalid', { errors: [{ path: 'owner', code: 'owner_too_long' }, { path: 'description', code: 'description_too_long' }, { path: 'rules[0].rollout', code: 'weights_sum_invalid', sum: 9000 }] }), { status: 422 }),
    );
    const { user } = await open();
    await edit(user);
    await user.click(save());
    const alert = await screen.findByRole('alert');
    expect(within(alert).getAllByRole('link')).toHaveLength(3);
    expect(within(alert).getByText(/Weights must add up to 100%/)).toBeInTheDocument();
    expect(screen.getByLabelText('Owner')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Owner')).toHaveAccessibleDescription('Owner can be at most 100 characters.');
    expect(screen.getByLabelText('Description')).toHaveAccessibleDescription('Description can be at most 500 characters.');
    await waitFor(() => expect(screen.getByLabelText('Owner')).toHaveFocus());
  });

  it('W06 FR-050: a body over the limit has its own sentence', async () => {
    answerPut(() => HttpResponse.json(problemBody(413, 'payload_too_large'), { status: 413 }));
    const { user } = await open();
    await edit(user);
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('This flag is too large to save. Remove variants, rules or long values.');
  });
});

describe('FlagEditor: lifecycle states', () => {
  it('W06 AS-33: Kill switch is available with unsaved edits, and the draft is left untouched', async () => {
    server.use(http.post(`${URL}/kill`, () => new HttpResponse(null, { status: 204 })));
    const { user } = await open(flagFixture({ status: 'enabled', enabled: true }));
    await edit(user);
    await user.click(screen.getByRole('button', { name: 'Kill switch' }));
    const dialog = await screen.findByRole('dialog');
    server_flag = flagFixture({ status: 'killed', version: 4 });
    await user.click(within(dialog).getByRole('button', { name: 'Kill flag' }));
    await waitFor(() => expect(screen.getByText(/This flag is killed\./)).toBeInTheDocument());
    expect(screen.getByLabelText('Description')).toHaveValue('Checkout v2 more');
    expect(toast).toHaveBeenCalledWith(`Flag ${KEY} killed.`);
  });

  it('W06 AS-34: a killed flag is announced, its switch is off and disabled with the reason, Restore and Archive are offered, Kill is not', async () => {
    await open(flagFixture({ status: 'killed', enabled: false }));
    expect(screen.getByText(/This flag is killed\. Everyone gets the off variant until it is restored\. Restoring makes it disabled; enabling it is a separate, deliberate save\./).closest('[role="status"]')).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Enabled' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription("A killed flag can't be enabled. Restore it first.");
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kill switch' })).not.toBeInTheDocument();
  });

  it('W06 AS-34: other fields of a killed flag stay savable, saved with enabled: false', async () => {
    answerPut(() => ok({ status: 'killed', description: 'Checkout v2 more' }));
    const { user } = await open(flagFixture({ status: 'killed', enabled: false }));
    await edit(user);
    await user.click(save());
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ enabled: false, description: 'Checkout v2 more' });
  });

  it('W06 AS-35: a save refused because the flag was killed meanwhile says so, refetches, and keeps Save disabled while the draft is enabled', async () => {
    answerPut(() => HttpResponse.json(problemBody(409, 'flag_killed'), { status: 409 }));
    const { user } = await open(flagFixture({ status: 'enabled', enabled: true }));
    await edit(user);
    server_flag = flagFixture({ status: 'killed', enabled: false, version: 4 });
    await user.click(save());
    expect(await screen.findByText(`${KEY} was killed while you were editing. It can't be enabled until it is restored.`)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/This flag is killed\./)).toBeInTheDocument());
    expect(save()).toBeDisabled();
    const toggle = screen.getByRole('switch', { name: 'Enabled' });
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    expect(save()).toBeEnabled();
  });

  it('W06 AS-37: an archived flag is read-only: every control disabled, the lifecycle buttons gone, the banner shown', async () => {
    await open(flagFixture({ status: 'archived' }));
    expect(screen.getByText("This flag is archived. It can't be edited, killed or restored.")).toBeInTheDocument();
    for (const label of ['Description', 'Owner', 'Client-side', 'Default variant', 'Off variant']) expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add variant' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeDisabled();
    for (const name of ['Kill switch', 'Restore', 'Archive']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('W06 AS-39: while a save is in flight the form is busy and the lifecycle buttons are disabled', async () => {
    let release!: () => void;
    server.use(
      http.put(URL, async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return ok();
      }),
    );
    const { user } = await open(flagFixture({ status: 'enabled', enabled: true }));
    await edit(user);
    await user.click(save());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Kill switch' })).toBeDisabled());
    expect(document.querySelector('form')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('Description')).toBeDisabled();
    release();
    await screen.findByText('Saved.');
  });

  it('W06 AS-36: restoring a killed flag makes the switch usable again', async () => {
    server.use(http.post(`${URL}/restore`, () => new HttpResponse(null, { status: 204 })));
    const { user } = await open(flagFixture({ status: 'killed', enabled: false }));
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    server_flag = flagFixture({ status: 'disabled', version: 4 });
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore flag' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enabled' })).toBeEnabled());
    expect(toast).toHaveBeenCalledWith(`Flag ${KEY} restored. It is disabled.`);
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { toast } from 'sonner';
import { TwoStepPanel } from './two-step-panel';

const origin = 'http://localhost:3000';
const KEY = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/Marketplace:me@example.com?secret=${KEY}&issuer=Marketplace`;
const CODES = ['ABCDE-FGHJK', 'MNPQR-STUVW', 'XYZ23-45678', 'ABCD2-34567', 'BCDEF-GHJKM', 'NPQRS-TUVWX', 'YZ234-56789', 'CDEFG-HJKMN', 'PQRST-UVWXY', 'Z2345-6789A'];

type Status = { state: 'none' | 'pending' | 'enabled'; enabledAt?: string; recoveryCodesRemaining?: number };
let status: Status;
const calls: Record<string, unknown[]> = {};

const record = async (name: string, request: Request) => {
  (calls[name] ??= []).push(await request.json().catch(() => null));
};
const problem = (code: string, httpStatus: number, headers: Record<string, string> = {}) =>
  HttpResponse.json({ code, status: httpStatus }, { status: httpStatus, headers });

function useStatus() {
  server.use(http.get(`${origin}/api/auth/mfa`, () => HttpResponse.json(status)));
}
function use(path: string, name: string, answer: (request: Request) => Response | Promise<Response>) {
  server.use(
    http.post(`${origin}/api/auth/mfa/${path}`, async ({ request }) => {
      await record(name, request.clone());
      return answer(request);
    }),
  );
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TwoStepPanel />
    </QueryClientProvider>,
  );
}

const enabled = (over: Partial<Status> = {}): Status => ({ state: 'enabled', enabledAt: '2026-03-05T12:00:00.000Z', recoveryCodesRemaining: 8, ...over });

async function openSetup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Set up' }));
  return screen.findByRole('dialog', { name: 'Set up two-step verification' });
}
async function toConfirmStep(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await openSetup(user);
  await user.click(within(dialog).getByRole('button', { name: 'Next' }));
  return dialog;
}

describe('TwoStepPanel', () => {
  beforeEach(() => {
    status = { state: 'none' };
    for (const key of Object.keys(calls)) delete calls[key];
    useStatus();
    use('enroll', 'enroll', () => HttpResponse.json({ otpauthUri: URI, manualEntryKey: KEY }));
  });
  afterEach(() => vi.clearAllMocks());

  it('W01 AS-45: shows a skeleton while loading', async () => {
    server.use(
      http.get(`${origin}/api/auth/mfa`, async () => {
        await delay(100);
        return HttpResponse.json(status);
      }),
    );
    mount();
    expect(screen.getByTestId('two-step-skeleton')).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByText('Two-step verification is off.')).toBeInTheDocument();
    expect(screen.queryByTestId('two-step-skeleton')).toBeNull();
  });

  it('W01 AS-45: a failed load shows the message with Retry, and Retry reads again', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${origin}/api/auth/mfa`, () => problem('internal_error', 500)));
    mount();
    expect(await screen.findByText("We couldn't load this section.")).toBeInTheDocument();
    useStatus();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Two-step verification is off.')).toBeInTheDocument();
  });

  it('W01 AS-45: state none offers Set up; pending offers Start over', async () => {
    mount();
    expect(await screen.findByText('Two-step verification is off.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up' })).toBeInTheDocument();
  });

  it('W01 AS-45: pending says setup was not finished', async () => {
    status = { state: 'pending' };
    mount();
    expect(await screen.findByText("Setup wasn't finished.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument();
  });

  it.each([
    [8, '8 recovery codes left', null],
    [1, '1 recovery code left', 'Only 1 recovery code left. Get new ones soon.'],
    [3, '3 recovery codes left', 'Only 3 recovery codes left. Get new ones soon.'],
    [0, '0 recovery codes left', 'You have no recovery codes left. Get new ones now.'],
  ])('W01 AS-45: enabled with %i codes left', async (left, count, prompt) => {
    status = enabled({ recoveryCodesRemaining: left });
    mount();
    expect(await screen.findByText(/Two-step verification is on since .*2026\./)).toBeInTheDocument();
    expect(screen.getByText(count)).toBeInTheDocument();
    if (prompt) expect(screen.getByText(prompt)).toBeInTheDocument();
    else expect(screen.queryByText(/Get new ones/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Get new recovery codes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument();
  });

  it('W01 AS-46: walks the three steps; the QR has the text alternative; Copy key copies the setup key', async () => {
    const user = userEvent.setup();
    use('confirm', 'confirm', () => {
      status = enabled({ recoveryCodesRemaining: 10 });
      return HttpResponse.json({ recoveryCodes: CODES });
    });
    mount();
    const dialog = await openSetup(user);
    expect(within(dialog).getByRole('img', { name: 'QR code for your authenticator app. The setup key below is the same secret.' })).toBeInTheDocument();
    expect(within(dialog).getByText(KEY)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Copy key' }));
    expect(await navigator.clipboard.readText()).toBe(KEY);
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.type(within(dialog).getByLabelText('6-digit code'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    const codes = await screen.findByRole('dialog', { name: 'Save your recovery codes' });
    expect(calls.confirm).toEqual([{ code: '123456' }]);
    for (const code of CODES) expect(codes).toHaveTextContent(code);
    await user.click(within(codes).getByRole('checkbox', { name: "I've saved these codes" }));
    await user.click(within(codes).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText(/Two-step verification is on since/)).toBeInTheDocument();
    expect(screen.getByText('10 recovery codes left')).toBeInTheDocument();
  });

  it('W01 AS-48: invalid_code clears and focuses the field and stays on the confirm step', async () => {
    const user = userEvent.setup();
    use('confirm', 'confirm', () => problem('invalid_code', 422));
    mount();
    const dialog = await toConfirmStep(user);
    await user.type(within(dialog).getByLabelText('6-digit code'), '000000');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByText("That code isn't right. Check your authenticator app and try again.")).toBeInTheDocument();
    const field = within(dialog).getByLabelText('6-digit code');
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('W01 AS-48: 429 shows the wait message', async () => {
    const user = userEvent.setup();
    use('confirm', 'confirm', () => problem('rate_limited', 429, { 'retry-after': '60' }));
    mount();
    const dialog = await toConfirmStep(user);
    await user.type(within(dialog).getByLabelText('6-digit code'), '000000');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByText('Too many incorrect codes. Try again in 1 minute.')).toBeInTheDocument();
  });

  it('W01 AS-48: mfa_not_pending says setup timed out and a new Set up starts a fresh enrolment', async () => {
    const user = userEvent.setup();
    use('confirm', 'confirm', () => problem('mfa_not_pending', 409));
    mount();
    const dialog = await toConfirmStep(user);
    await user.type(within(dialog).getByLabelText('6-digit code'), '000000');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.error).toHaveBeenCalledWith('Setup timed out. Start again.');
    await openSetup(user);
    expect(calls.enroll).toHaveLength(2);
  });

  it.each([
    ['mfa_already_enabled', 'Two-step verification is already on.'],
    ['mfa_not_enabled', "Two-step verification isn't turned on."],
  ])('W01 AS-49: a stale status (%s on enrol) closes the dialog, re-reads the status and toasts the real situation', async (code, message) => {
    const user = userEvent.setup();
    use('enroll', 'enroll', () => {
      status = enabled();
      return problem(code, 409);
    });
    mount();
    await user.click(await screen.findByRole('button', { name: 'Set up' }));
    expect(await screen.findByText(/Two-step verification is on since/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(message);
  });

  it('W01 AS-49: mfa_not_enabled on regenerate closes the dialog, re-reads the status and toasts', async () => {
    const user = userEvent.setup();
    status = enabled();
    use('recovery-codes/regenerate', 'regenerate', () => {
      status = { state: 'none' };
      return problem('mfa_not_enabled', 409);
    });
    mount();
    await user.click(await screen.findByRole('button', { name: 'Get new recovery codes' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Authentication code'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Get new codes' }));
    expect(await screen.findByText('Two-step verification is off.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("Two-step verification isn't turned on.");
  });

  it('W01 AS-50: pending offers Start over, which calls enrol again and shows the new key', async () => {
    const user = userEvent.setup();
    status = { state: 'pending' };
    mount();
    await user.click(await screen.findByRole('button', { name: 'Start over' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up two-step verification' });
    expect(within(dialog).getByText(KEY)).toBeInTheDocument();
    expect(calls.enroll).toHaveLength(1);
  });

  it('W01 AS-51: regenerate asks for the authenticator code only and shows the new codes', async () => {
    const user = userEvent.setup();
    status = enabled({ recoveryCodesRemaining: 2 });
    use('recovery-codes/regenerate', 'regenerate', () => {
      status = enabled({ recoveryCodesRemaining: 10 });
      return HttpResponse.json({ recoveryCodes: CODES });
    });
    mount();
    await user.click(await screen.findByRole('button', { name: 'Get new recovery codes' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Use the code from your authenticator app')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Recovery code')).toBeNull();
    await user.type(within(dialog).getByLabelText('Authentication code'), '654321');
    await user.click(within(dialog).getByRole('button', { name: 'Get new codes' }));
    const codes = await screen.findByRole('dialog', { name: 'Save your recovery codes' });
    expect(calls.regenerate).toEqual([{ code: '654321' }]);
    expect(codes).toHaveTextContent(CODES[0]);
  });

  it('W01 AS-51: regenerate errors show as on setup', async () => {
    const user = userEvent.setup();
    status = enabled();
    use('recovery-codes/regenerate', 'regenerate', () => problem('invalid_code', 422));
    mount();
    await user.click(await screen.findByRole('button', { name: 'Get new recovery codes' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Authentication code'), '111111');
    await user.click(within(dialog).getByRole('button', { name: 'Get new codes' }));
    expect(await within(dialog).findByText("That code isn't right. Check your authenticator app and try again.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Authentication code')).toHaveFocus();
  });

  it('W01 AS-52: turn off warns, accepts a recovery code, closes on 204, shows none and toasts', async () => {
    const user = userEvent.setup();
    status = enabled();
    use('disable', 'disable', () => {
      status = { state: 'none' };
      return new HttpResponse(null, { status: 204 });
    });
    mount();
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Your account will be protected by your password only.');
    await user.type(within(dialog).getByLabelText('Authenticator or recovery code'), 'abcde fghjk');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('Two-step verification is off.')).toBeInTheDocument();
    expect(calls.disable).toEqual([{ code: 'ABCDE-FGHJK' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('Two-step verification is off.');
  });

  it('W01 AS-52: turn off accepts an authenticator code and shows 422 and 429 as on setup', async () => {
    const user = userEvent.setup();
    status = enabled();
    let attempt = 0;
    use('disable', 'disable', () => (++attempt === 1 ? problem('invalid_code', 422) : problem('rate_limited', 429, { 'retry-after': '120' })));
    mount();
    await user.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Authenticator or recovery code'), '123 456');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await within(dialog).findByText("That code isn't right. Check your authenticator app and try again.")).toBeInTheDocument();
    expect(calls.disable).toEqual([{ code: '123456' }]);
    await user.type(within(dialog).getByLabelText('Authenticator or recovery code'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await within(dialog).findByText('Too many incorrect codes. Try again in 2 minutes.')).toBeInTheDocument();
  });
});

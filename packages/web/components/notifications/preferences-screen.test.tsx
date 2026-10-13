import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { setSessionPresence } from '@/lib/api/session-presence';
import { preferencesBody } from '../../tests/msw/notifications';
import { server } from '../../vitest.setup';
import { PreferencesScreen } from './preferences-screen';

const origin = 'http://localhost:3000';
const problem = (status: number, code: string, headers: Record<string, string> = {}) => HttpResponse.json({ code }, { status, headers });

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(<PreferencesScreen />, { wrapper });
}

const serveMatrix = (body = preferencesBody()) => server.use(http.get(`${origin}/api/notifications/preferences`, () => HttpResponse.json(body)));

describe('PreferencesScreen', () => {
  beforeEach(() => {
    rearmSessionEnd();
    setSessionEndHandler(vi.fn());
    setSessionPresence(() => true);
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('S28 AS-14: shows 13 categories by 4 channels as switches with the stored values; mandatory cells are locked on', async () => {
    serveMatrix();
    show();
    expect(await screen.findByRole('switch', { name: 'Orders: Email' })).toBeChecked();
    expect(screen.getAllByRole('switch')).toHaveLength(13 * 4);
    expect(screen.getByRole('switch', { name: 'Marketing: Email' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Orders: In the app' })).toBeChecked();
    const locked = screen.getByRole('switch', { name: 'Security: Email (required)' });
    expect(locked).toBeChecked();
    expect(locked).toBeDisabled();
  });

  it('S28 AS-18: text-message switches are disabled until the phone is verified', async () => {
    serveMatrix();
    const first = show();
    expect(await screen.findByRole('switch', { name: 'Orders: Text message' })).toBeDisabled();
    expect(screen.getByText('Verify your phone number to turn on text messages.')).toBeInTheDocument();
    first.unmount();
    serveMatrix(preferencesBody({ phone: '+38******67', phoneVerified: true }));
    show();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Orders: Text message' })).toBeEnabled());
  });

  it('S28 AS-15: flipping a switch sends one PUT for that cell and keeps the server answer', async () => {
    serveMatrix();
    const bodies: unknown[] = [];
    server.use(
      http.put(`${origin}/api/notifications/preferences`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(preferencesBody({}, { category: 'orders', channel: 'email', enabled: false }));
      }),
    );
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Orders: Email' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Orders: Email' })).not.toBeChecked());
    expect(bodies).toEqual([{ category: 'orders', channel: 'email', enabled: false }]);
  });

  it('S28 AS-15: a refused write puts the switch back and says why', async () => {
    serveMatrix();
    server.use(http.put(`${origin}/api/notifications/preferences`, () => problem(429, 'rate_limited', { 'Retry-After': '30' })));
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Chat: Push' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests. Try again in 30 seconds.');
    expect(screen.getByRole('switch', { name: 'Chat: Push' })).toBeChecked();
  });

  it('S28 AS-21: the phone is set in international format, only the masked number is shown, then the code verifies it', async () => {
    let current = preferencesBody();
    const sent: unknown[] = [];
    server.use(
      http.get(`${origin}/api/notifications/preferences`, () => HttpResponse.json(current)),
      http.put(`${origin}/api/notifications/settings`, async ({ request }) => {
        sent.push(await request.json());
        current = preferencesBody({ phone: '+38******67', phoneVerified: false });
        return HttpResponse.json(current);
      }),
      http.post(`${origin}/api/notifications/settings/phone/verify`, async ({ request }) => {
        sent.push(await request.json());
        current = preferencesBody({ phone: '+38******67', phoneVerified: true });
        return HttpResponse.json(current);
      }),
    );
    show();
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Phone number' }), '12345');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('Enter the number in international format, like +380501234567.')).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox', { name: 'Phone number' }));
    await user.type(screen.getByRole('textbox', { name: 'Phone number' }), '+380501234567');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('+38******67')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('380501234567');
    await user.type(await screen.findByLabelText('Verification code'), '12ab');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('The code has 6 digits.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Verification code'), '3456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Your phone number is verified.')).toBeInTheDocument();
    expect(sent).toEqual([{ phone: '+380501234567' }, { code: '123456' }]);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Orders: Text message' })).toBeEnabled());
  });

  it('S28 AS-22: a wrong code and an expired code show their messages', async () => {
    serveMatrix(preferencesBody({ phone: '+38******67' }));
    let code = 'code_invalid';
    server.use(http.post(`${origin}/api/notifications/settings/phone/verify`, () => problem(422, code)));
    show();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Verification code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right.');
    code = 'code_expired';
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That code has expired. Request a new one.'));
  });

  it('S28 AS-23: asking for a new code over the limit says when to try again', async () => {
    serveMatrix(preferencesBody({ phone: '+38******67' }));
    server.use(http.post(`${origin}/api/notifications/settings/phone/code`, () => problem(429, 'rate_limited', { 'Retry-After': '3000' })));
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Send a new code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests. Try again in 50 minutes.');
  });

  it('S28 AS-19: quiet hours, time zone and language are saved together; clearing quiet hours sends nulls', async () => {
    serveMatrix();
    const bodies: unknown[] = [];
    server.use(
      http.put(`${origin}/api/notifications/settings`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(preferencesBody({ timezone: 'Europe/Kyiv', locale: 'uk', quietStart: '22:00', quietEnd: '07:30' }));
      }),
    );
    show();
    const user = userEvent.setup();
    const form = within(await screen.findByRole('form', { name: 'Quiet hours, time zone and language' }));
    await user.type(form.getByLabelText('Quiet hours start'), '22:00');
    await user.type(form.getByLabelText('Quiet hours end'), '07:30');
    await user.clear(form.getByLabelText('Time zone'));
    await user.type(form.getByLabelText('Time zone'), 'Europe/Kyiv');
    await user.selectOptions(form.getByLabelText('Language'), 'uk');
    await user.click(form.getByRole('button', { name: 'Save settings' }));
    expect(await form.findByText('Settings saved.')).toBeInTheDocument();
    expect(bodies).toEqual([{ timezone: 'Europe/Kyiv', locale: 'uk', quietStart: '22:00', quietEnd: '07:30' }]);
    await user.click(form.getByRole('button', { name: 'Clear quiet hours' }));
    await user.click(form.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ quietStart: null, quietEnd: null });
  });

  it('S28 AS-20: quiet_hours_incomplete is shown next to the form', async () => {
    serveMatrix();
    server.use(http.put(`${origin}/api/notifications/settings`, () => problem(422, 'quiet_hours_incomplete')));
    show();
    const user = userEvent.setup();
    const form = within(await screen.findByRole('form', { name: 'Quiet hours, time zone and language' }));
    await user.type(form.getByLabelText('Quiet hours start'), '22:00');
    await user.click(form.getByRole('button', { name: 'Save settings' }));
    expect(await form.findByRole('alert')).toHaveTextContent('Set both the start and the end of quiet hours, or clear both.');
  });

  it('S28 AS-16: a failed load says so and Try again reads it again', async () => {
    let ok = false;
    server.use(http.get(`${origin}/api/notifications/preferences`, () => (ok ? HttpResponse.json(preferencesBody()) : problem(400, 'validation_failed'))));
    show();
    const user = userEvent.setup();
    expect(await screen.findByText("We couldn't load your notification settings.")).toBeInTheDocument();
    ok = true;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('switch', { name: 'Orders: Email' })).toBeInTheDocument();
  });
});

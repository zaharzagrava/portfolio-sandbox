import type { ReactNode } from 'react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPreferences } from '@marketplace-sandbox/contracts';
import { preferencesBody } from '../../tests/msw/notifications';
import { server } from '../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { setSessionPresence } from './session-presence';
import {
  listDevices,
  postUnsubscribe,
  putSettings,
  registerDevice,
  removeDevice,
  settingsErrorText,
  useRequestPhoneCode,
  useUpdatePreference,
  useVerifyPhone,
  fetchPreferences,
} from './notifications';

const origin = 'http://localhost:3000';
const DEVICE = '5b4d0e1f-7c6a-4f81-9a9d-3e4f5a6b7c8d';

const matrix = preferencesBody;

const problem = (status: number, code: string, headers: Record<string, string> = {}) => HttpResponse.json({ code }, { status, headers });

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, Wrapper };
}

describe('notification preferences api', () => {
  beforeEach(() => {
    rearmSessionEnd();
    setSessionEndHandler(vi.fn());
    setSessionPresence(() => true);
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('S28 AS-14: GET /api/notifications/preferences is parsed with the contract schema (13 categories, masked phone)', async () => {
    server.use(http.get(`${origin}/api/notifications/preferences`, () => HttpResponse.json(matrix({ phone: '+38******67' }))));
    const result = await fetchPreferences();
    expect(result.preferences).toHaveLength(13);
    expect(result.settings.phone).toBe('+38******67');
    expect(result.preferences.find((row) => row.category === 'security')?.mandatoryChannels).toEqual(['email']);
  });

  it('S28 AS-14: a body that breaks the contract is a failed call', async () => {
    server.use(http.get(`${origin}/api/notifications/preferences`, () => HttpResponse.json({ settings: {}, preferences: [] })));
    await expect(fetchPreferences()).rejects.toMatchObject({ response: { status: 500, data: { code: 'invalid_response' } } });
  });

  it('S28 AS-15: a cell flips at once, the PUT carries {category, channel, enabled}, and the server matrix wins', async () => {
    let body: unknown;
    server.use(
      http.put(`${origin}/api/notifications/preferences`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(matrix({}, { category: 'orders', channel: 'email', enabled: false }));
      }),
    );
    const { client, Wrapper } = wrapper();
    client.setQueryData(queryKeys.notifications.preferences(), matrix());
    const { result } = renderHook(() => useUpdatePreference(), { wrapper: Wrapper });
    act(() => result.current.mutate({ category: 'orders', channel: 'email', enabled: false }));
    await waitFor(() => expect(client.getQueryData<NotificationPreferences>(queryKeys.notifications.preferences())?.preferences.find((r) => r.category === 'orders')?.channels.email).toBe(false));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(body).toEqual({ category: 'orders', channel: 'email', enabled: false });
  });

  it('S28 AS-18: 422 phone_not_verified rolls the cell back and has its own text', async () => {
    server.use(http.put(`${origin}/api/notifications/preferences`, () => problem(422, 'phone_not_verified')));
    const { client, Wrapper } = wrapper();
    client.setQueryData(queryKeys.notifications.preferences(), matrix());
    const { result } = renderHook(() => useUpdatePreference(), { wrapper: Wrapper });
    act(() => result.current.mutate({ category: 'orders', channel: 'sms', enabled: true }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData<NotificationPreferences>(queryKeys.notifications.preferences())?.preferences.find((r) => r.category === 'orders')?.channels.sms).toBe(false);
    expect(settingsErrorText(result.current.error)).toBe('Verify your phone number before turning on text messages.');
  });

  it('S28 AS-19: PUT /api/notifications/settings sends the changed fields and parses the matrix', async () => {
    let body: unknown;
    server.use(
      http.put(`${origin}/api/notifications/settings`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(matrix({ timezone: 'Europe/Kyiv', locale: 'uk', quietStart: '22:00', quietEnd: '07:30' }));
      }),
    );
    const result = await putSettings({ timezone: 'Europe/Kyiv', locale: 'uk', quietStart: '22:00', quietEnd: '07:30' });
    expect(body).toEqual({ timezone: 'Europe/Kyiv', locale: 'uk', quietStart: '22:00', quietEnd: '07:30' });
    expect(result.settings).toMatchObject({ timezone: 'Europe/Kyiv', locale: 'uk', quietEnd: '07:30' });
  });

  it('S28 AS-20: quiet_hours_incomplete and quiet_hours_invalid (422) have their texts', async () => {
    server.use(http.put(`${origin}/api/notifications/settings`, () => problem(422, 'quiet_hours_incomplete')));
    const error = await putSettings({ quietStart: '22:00' }).catch((e: unknown) => e);
    expect(settingsErrorText(error)).toBe('Set both the start and the end of quiet hours, or clear both.');
    expect(settingsErrorText({ response: { status: 422, data: { code: 'quiet_hours_invalid' } } })).toBe('Quiet hours cannot start and end at the same time.');
  });

  it('S28 AS-21: the phone code is requested with POST .../phone/code (202) and verified with {code}', async () => {
    let verifyBody: unknown;
    server.use(
      http.post(`${origin}/api/notifications/settings/phone/code`, () => HttpResponse.json({}, { status: 202 })),
      http.post(`${origin}/api/notifications/settings/phone/verify`, async ({ request }) => {
        verifyBody = await request.json();
        return HttpResponse.json(matrix({ phone: '+38******67', phoneVerified: true }));
      }),
    );
    const { client, Wrapper } = wrapper();
    const code = renderHook(() => useRequestPhoneCode(), { wrapper: Wrapper });
    await act(() => code.result.current.mutateAsync());
    const verify = renderHook(() => useVerifyPhone(), { wrapper: Wrapper });
    await act(() => verify.result.current.mutateAsync('123456'));
    expect(verifyBody).toEqual({ code: '123456' });
    expect(client.getQueryData<NotificationPreferences>(queryKeys.notifications.preferences())?.settings.phoneVerified).toBe(true);
  });

  it('S28 AS-22: verification failures have their texts: code_invalid, code_expired, code_not_requested, verification_locked (429 + wait)', () => {
    const fail = (status: number, code: string, headers: Record<string, string> = {}) => settingsErrorText({ response: { status, data: { code }, headers } });
    expect(fail(422, 'code_invalid')).toBe('That code is not right. Check the message and try again.');
    expect(fail(422, 'code_expired')).toBe('That code has expired. Request a new one.');
    expect(fail(422, 'code_not_requested')).toBe('Request a code first.');
    expect(fail(429, 'verification_locked', { 'retry-after': '900' })).toBe('Too many wrong codes. Try again in 15 minutes.');
  });

  it('S28 AS-23: a code request over the limit is 429 with the wait, and phone_missing / phone_unreachable have texts', () => {
    expect(settingsErrorText({ response: { status: 429, data: { code: 'rate_limited' }, headers: { 'retry-after': '120' } } })).toBe('Too many requests. Try again in 2 minutes.');
    expect(settingsErrorText({ response: { status: 422, data: { code: 'phone_missing' } } })).toBe('Add a phone number first.');
    expect(settingsErrorText({ response: { status: 422, data: { code: 'phone_unreachable' } } })).toBe("We can't send text messages to that number.");
    expect(settingsErrorText(new Error('network'))).toBe("You're offline. Check your connection and try again.");
    expect(settingsErrorText({ response: { status: 500, data: {} } })).toBe('Something went wrong. Try again.');
  });

  it('S28 AS-28: registerDevice answers {id, platform, lastSeenAt} for 201 and 200; listDevices parses the list (no token)', async () => {
    const device = { id: DEVICE, platform: 'web', lastSeenAt: '2026-10-11T10:00:00.000Z' };
    let status = 201;
    server.use(
      http.post(`${origin}/api/notifications/devices`, () => HttpResponse.json(device, { status })),
      http.get(`${origin}/api/notifications/devices`, () => HttpResponse.json({ items: [device] })),
    );
    expect(await registerDevice({ token: 't', platform: 'web' })).toEqual(device);
    status = 200;
    expect(await registerDevice({ token: 't', platform: 'web' })).toEqual(device);
    expect(await listDevices()).toEqual({ items: [device] });
  });

  it('S28 AS-29: removeDevice calls DELETE /api/notifications/devices/:id; another user\'s device is 404 device_not_found', async () => {
    server.use(
      http.delete(`${origin}/api/notifications/devices/${DEVICE}`, () => new HttpResponse(null, { status: 204 })),
      http.delete(`${origin}/api/notifications/devices/other`, () => problem(404, 'device_not_found')),
    );
    await expect(removeDevice(DEVICE)).resolves.toBeUndefined();
    await expect(removeDevice('other')).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('S28 AS-25: postUnsubscribe POSTs with the token in the query, anonymously (no CSRF header), and returns the category', async () => {
    let seen: { token: string | null; csrf: string | null } | undefined;
    server.use(
      http.post(`${origin}/api/notifications/unsubscribe`, ({ request }) => {
        seen = { token: new URL(request.url).searchParams.get('token'), csrf: request.headers.get('x-csrf-token') };
        return HttpResponse.json({ unsubscribed: 'orders' });
      }),
    );
    expect(await postUnsubscribe('abc.def')).toBe('orders');
    expect(seen).toEqual({ token: 'abc.def', csrf: null });
  });

  it('S28 AS-26: an invalid unsubscribe token is a 400 invalid_unsubscribe_token failure', async () => {
    server.use(http.post(`${origin}/api/notifications/unsubscribe`, () => problem(400, 'invalid_unsubscribe_token')));
    await expect(postUnsubscribe('bad')).rejects.toMatchObject({ response: { status: 400, data: { code: 'invalid_unsubscribe_token' } } });
  });
});

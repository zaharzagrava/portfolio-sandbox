import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../vitest.setup';
import { queryKeys } from '@/lib/query-keys';

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const announce = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session-sync')>()),
  announceAuth: announce,
  subscribeAuth: vi.fn(() => () => undefined),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { SessionLifecycle } from '@/components/auth/session-lifecycle';
import { endSession, rearmSessionEnd } from '@/lib/auth/session-ended';
import { useLogin, useLogout, useRefreshSession, useVerifyMfa } from './use-auth-actions';

const origin = 'http://localhost:3000';
const view = (role = 'USER') => ({ user: { id: 'u1', email: 'a@b.co', role }, expiresAt: '2026-01-02T00:00:00.000Z' });

let client: QueryClient;
let actions: { login: ReturnType<typeof useLogin>; mfa: ReturnType<typeof useVerifyMfa>; logout: ReturnType<typeof useLogout>; refresh: ReturnType<typeof useRefreshSession> };

function Harness({ returnTo }: { returnTo?: string }) {
  const value = { login: useLogin(returnTo), mfa: useVerifyMfa(returnTo), logout: useLogout(), refresh: useRefreshSession() };
  useEffect(() => {
    actions = value;
  });
  return null;
}
const mount = (ui: ReactNode) => render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

describe('auth actions', () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    Object.values(router).forEach((fn) => fn.mockClear());
    announce.mockClear();
    toast.mockClear();
    toast.error.mockClear();
    rearmSessionEnd();
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  });
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-06: useLogin applies the sign-in effects once, with the guest cart merge requested', async () => {
    let merges = 0;
    server.use(
      http.post(`${origin}/api/bff/session`, () => HttpResponse.json(view())),
      http.post(`${origin}/api/cart/merge`, () => {
        merges++;
        return HttpResponse.json({ lines: [] });
      }),
    );
    client.setQueryData(['products'], ['cached for the visitor']);
    mount(<Harness returnTo="/account/security" />);
    await act(async () => {
      await actions.login.mutateAsync({ email: 'a@b.co', password: 'x' });
    });
    expect(client.getQueryData(queryKeys.auth.session())).toEqual({ id: 'u1', email: 'a@b.co', role: 'USER' });
    expect(client.getQueryState(['products'])?.isInvalidated).toBe(true);
    await waitFor(() => expect(merges).toBe(1));
    expect(router.replace).toHaveBeenCalledWith('/account/security');
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('signed-in');
  });

  it('W01 AS-06: without returnTo the destination is / and an unsafe one is replaced', async () => {
    server.use(http.post(`${origin}/api/bff/session`, () => HttpResponse.json(view())), http.post(`${origin}/api/cart/merge`, () => HttpResponse.json({})));
    mount(<Harness returnTo="//evil.example" />);
    await act(async () => {
      await actions.login.mutateAsync({ email: 'a@b.co', password: 'x' });
    });
    expect(router.replace).toHaveBeenCalledWith('/');
  });

  it('W01 AS-13: an mfa_required answer changes nothing; the caller routes to the second step', async () => {
    server.use(http.post(`${origin}/api/bff/session`, () => HttpResponse.json({ mfaRequired: true })));
    mount(<Harness />);
    let result: unknown;
    await act(async () => {
      result = await actions.login.mutateAsync({ email: 'a@b.co', password: 'x' });
    });
    expect(result).toEqual({ ok: true, kind: 'mfa_required' });
    expect(router.replace).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.auth.session())).toBeUndefined();
  });

  it('W01 AS-32: useVerifyMfa applies the same sign-in effects', async () => {
    server.use(http.post(`${origin}/api/bff/session/mfa`, () => HttpResponse.json(view('SELLER'))), http.post(`${origin}/api/cart/merge`, () => HttpResponse.json({})));
    mount(<Harness returnTo="/orders" />);
    await act(async () => {
      await actions.mfa.mutateAsync('123456');
    });
    expect(client.getQueryData(queryKeys.auth.session())).toMatchObject({ role: 'SELLER' });
    expect(router.replace).toHaveBeenCalledWith('/orders');
  });

  it('W01 AS-24: useLogout clears the cache, broadcasts, and navigates to the signed-out notice', async () => {
    server.use(http.post(`${origin}/api/bff/session/logout`, () => new HttpResponse(null, { status: 204 })));
    client.setQueryData(queryKeys.auth.session(), { id: 'u1', email: 'a@b.co', role: 'USER' });
    client.setQueryData(['orders'], [1]);
    mount(<Harness />);
    await act(async () => {
      await actions.logout.mutateAsync();
    });
    expect(client.getQueryData(['orders'])).toBeUndefined();
    expect(client.getQueryData(queryKeys.auth.session())).toBeNull();
    expect(announce).toHaveBeenCalledWith('signed-out');
    expect(router.replace).toHaveBeenCalledWith('/login?notice=signed_out');
  });

  it.each([
    ['500', () => HttpResponse.json({ code: 'internal_error' }, { status: 500 }), "We couldn't sign you out. Try again.", 'Try again'],
    ['network failure', () => HttpResponse.error(), "We couldn't sign you out. Try again.", 'Try again'],
    ['403 csrf_invalid', () => HttpResponse.json({ code: 'csrf_invalid' }, { status: 403 }), 'Reload the page and try again.', 'Reload'],
  ])('W01 AS-25: a failed logout (%s) keeps the session and offers a retry', async (_name, answer, message, label) => {
    server.use(http.post(`${origin}/api/bff/session/logout`, answer));
    const user = { id: 'u1', email: 'a@b.co', role: 'USER' };
    client.setQueryData(queryKeys.auth.session(), user);
    mount(<Harness />);
    await act(async () => {
      await actions.logout.mutateAsync();
    });
    expect(client.getQueryData(queryKeys.auth.session())).toEqual(user);
    expect(router.replace).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(message, expect.objectContaining({ action: expect.objectContaining({ label }) }));
  });

  it('W01 AS-23: useRefreshSession writes the returned role to the session query', async () => {
    server.use(http.post(`${origin}/api/bff/session/refresh`, () => HttpResponse.json(view('SELLER'))));
    client.setQueryData(queryKeys.auth.session(), { id: 'u1', email: 'a@b.co', role: 'USER' });
    mount(<Harness />);
    await act(async () => {
      await actions.refresh.mutateAsync();
    });
    expect(client.getQueryData(queryKeys.auth.session())).toMatchObject({ role: 'SELLER' });
  });

  it('W01 AS-26: expiry drops the cache, refreshes server guards and toasts a Sign in link carrying returnTo and notice', async () => {
    window.history.pushState({}, '', '/products/espresso?tab=reviews');
    client.setQueryData(queryKeys.auth.session(), { id: 'u1', email: 'a@b.co', role: 'USER' });
    client.setQueryData(['orders'], [1]);
    mount(<SessionLifecycle />);
    act(() => {
      endSession();
      endSession();
    });
    expect(client.getQueryData(['orders'])).toBeUndefined();
    expect(client.getQueryData(queryKeys.auth.session())).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    const [message, options] = toast.mock.calls[0];
    expect(message).toBe('Your session ended. Sign in again to continue.');
    options.action.onClick();
    expect(router.push).toHaveBeenCalledWith('/login?returnTo=%2Fproducts%2Fespresso%3Ftab%3Dreviews&notice=session_expired');
    window.history.pushState({}, '', '/');
  });
});

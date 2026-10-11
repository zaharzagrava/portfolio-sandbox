import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { AuthBootstrap, useAuth } from './use-auth';

const session = (role = 'USER') => ({ user: { id: 'u1', email: 'a@b.co', role }, expiresAt: '2026-01-02T00:00:00.000Z' });
const url = 'http://localhost:3000/api/bff/session';

function Probe() {
  const { user, status, isAuthenticated, isLoading } = useAuth();
  return (
    <p data-testid="probe">
      {status}|{user?.email ?? '-'}|{user?.role ?? '-'}|{String(isAuthenticated)}|{String(isLoading)}
    </p>
  );
}

function setup(children: ReactNode = <Probe />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
  return { client, ...wrapper };
}
const text = () => screen.getByTestId('probe').textContent;

describe('useAuth', () => {
  beforeEach(() => {
    rearmSessionEnd();
    setSessionEndHandler(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-21: reads the session from the BFF and exposes a read-only view', async () => {
    server.use(http.get(url, () => HttpResponse.json(session('SELLER'))));
    setup();
    expect(text()).toBe('loading|-|-|false|true');
    await waitFor(() => expect(text()).toBe('authenticated|a@b.co|SELLER|true|false'));
  });

  it('W01 AS-21: a 401 is anonymous', async () => {
    server.use(http.get(url, () => HttpResponse.json({ code: 'unauthenticated' }, { status: 401 })));
    setup();
    await waitFor(() => expect(text()).toBe('anonymous|-|-|false|false'));
  });

  it('W01 AS-20: a 503 keeps the previous user and reports unavailable; the next success recovers', async () => {
    let healthy = true;
    server.use(
      http.get(url, () => (healthy ? HttpResponse.json(session()) : HttpResponse.json({ code: 'session_unavailable' }, { status: 503 }))),
    );
    const { client } = setup();
    await waitFor(() => expect(text()).toContain('authenticated|a@b.co'));
    healthy = false;
    await act(() => client.invalidateQueries({ queryKey: queryKeys.auth.session() }));
    await waitFor(() => expect(text()).toBe('unavailable|a@b.co|USER|true|false'));
    healthy = true;
    await act(() => client.invalidateQueries({ queryKey: queryKeys.auth.session() }));
    await waitFor(() => expect(text()).toContain('authenticated|a@b.co'));
  });

  it('W01 AS-20: with no answer at all and no previous user the status is unavailable, never anonymous', async () => {
    server.use(http.get(url, () => HttpResponse.error()));
    setup();
    await waitFor(() => expect(text()).toBe('unavailable|-|-|false|false'));
  });

  it('W01 AS-20: refetches when the browser comes back online', async () => {
    let calls = 0;
    server.use(
      http.get(url, () => {
        calls++;
        return HttpResponse.json(session());
      }),
    );
    setup();
    await waitFor(() => expect(calls).toBe(1));
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
  });

  it('W01 AS-22: refetches when the tab regains focus (fallback where BroadcastChannel is missing)', async () => {
    let calls = 0;
    server.use(
      http.get(url, () => {
        calls++;
        return HttpResponse.json(session());
      }),
    );
    setup();
    await waitFor(() => expect(calls).toBe(1));
    // inside the 60 s stale window: the focus refetch must still happen
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
  });

  it('W01 AS-26: a 401 after a known user runs the session-ended flow once', async () => {
    const ended = vi.fn();
    setSessionEndHandler(ended);
    let signedIn = true;
    server.use(http.get(url, () => (signedIn ? HttpResponse.json(session()) : HttpResponse.json({ code: 'session_expired' }, { status: 401 }))));
    const { client } = setup();
    await waitFor(() => expect(text()).toContain('authenticated'));
    signedIn = false;
    await act(() => client.invalidateQueries({ queryKey: queryKeys.auth.session() }));
    await waitFor(() => expect(text()).toContain('anonymous'));
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('W01 AS-18: AuthBootstrap seeds the first value from the server so there is no signed-out flash', () => {
    server.use(http.get(url, () => new Promise(() => undefined)));
    setup(
      <>
        <AuthBootstrap user={{ id: 'u1', email: 'a@b.co', role: 'USER' }} />
        <Probe />
      </>,
    );
    expect(text()).toBe('authenticated|a@b.co|USER|true|false');
  });
});

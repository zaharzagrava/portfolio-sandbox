import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { queryKeys } from '@/lib/query-keys';

/**
 * Test doubles for the console's component tests (W06 gaps F8, F9): a render helper with a QueryClient and the session of the
 * signed-in viewer (what `useAuth()` reads), a `navigation` double for `next/navigation`, the clipboard, online/offline events and
 * a recorder for toasts. Requests are answered by the shared MSW server (`server.use`) with bodies from `flag-fixtures`.
 */
export const ADMIN_USER = { id: 'u-admin', email: 'admin@marketplace.local', role: 'ADMIN' as const };

export const navigation = {
  pathname: '/admin/feature-flags',
  search: '',
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() },
};

/** `vi.mock('next/navigation', () => navigationMock())` */
export function navigationMock() {
  return {
    usePathname: () => navigation.pathname,
    useSearchParams: () => new URLSearchParams(navigation.search),
    useRouter: () => navigation.router,
    notFound: () => {
      throw new Error('NEXT_NOT_FOUND');
    },
    redirect: (to: string) => {
      throw new Error(`NEXT_REDIRECT:${to}`);
    },
  };
}

export function resetNavigation() {
  navigation.pathname = '/admin/feature-flags';
  navigation.search = '';
  for (const fn of Object.values(navigation.router)) fn.mockReset();
}

export function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity }, mutations: { retry: false } } });
}

export function renderAdmin(ui: ReactElement, options: { client?: QueryClient; user?: typeof ADMIN_USER | null } = {}) {
  const client = options.client ?? newClient();
  client.setQueryData(queryKeys.auth.session(), options.user === undefined ? ADMIN_USER : options.user);
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return {
    client,
    user: userEvent.setup(),
    ...view,
    rerenderAdmin: (next: ReactElement) => view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  };
}

/** Browser online state: `setOnline(false)` fires `offline`, `setOnline(true)` fires `online`. */
export function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  act(() => void window.dispatchEvent(new Event(online ? 'online' : 'offline')));
}

export function stubClipboard(impl: (text: string) => Promise<void> = () => Promise.resolve()) {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText: vi.fn(() => Promise.resolve('')) } });
  return writeText;
}

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { isValidElement, Suspense, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderPageResponse } from '@marketplace-sandbox/contracts';
import { loginHref } from '@/lib/auth/return-to';
import { queryKeys } from '@/lib/query-keys';
import { orderBody } from '../../../../tests/msw/handlers';

class Redirected extends Error {
  constructor(readonly url: string) {
    super('redirect');
  }
}
class NotFound extends Error {}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
  notFound: () => {
    throw new NotFound();
  },
}));

const requireServerSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session.server', () => ({ requireServerSession }));
const getOrderAggregate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/orders.server', () => ({ getOrderAggregate }));

/** The real view is a client tree with its own tests (UK8); here it only shows what the page handed it. */
vi.mock('@/components/checkout/success-view', () => ({
  SuccessView: function SuccessViewStub({ orderId }: { orderId: string }) {
    const client = useQueryClient();
    const cached = client.getQueryData<OrderPageResponse>(queryKeys.orders.detail(orderId));
    return (
      <p>
        success view {orderId} cached {cached ? cached.order.status : 'nothing'}
      </p>
    );
  },
}));

import SuccessPage from './page';

const ID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

const aggregate = (status: OrderPageResponse['order']['status'] = 'PAID'): OrderPageResponse => ({
  order: orderBody({ status }),
  payment: null,
  errors: [],
});

/** The page is a static shell around one async component inside `<Suspense>` (AS-70): find it and run it, as the server would. */
function findGuarded(node: ReactNode): ReactElement | null {
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function') return element;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findGuarded(child as ReactNode);
    if (found) return found;
  }
  return null;
}

/** The `<Suspense>` boundary of the shell: its fallback is what is delivered before any request-time read. */
function findSuspense(node: ReactNode): ReactElement<{ fallback?: ReactNode; children?: ReactNode }> | null {
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ fallback?: ReactNode; children?: ReactNode }>;
  if (element.type === Suspense) return element;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findSuspense(child as ReactNode);
    if (found) return found;
  }
  return null;
}

async function open(orderId: string): Promise<{ error?: unknown; tree?: ReactNode }> {
  const guarded = findGuarded(SuccessPage({ params: Promise.resolve({ orderId }) }));
  if (!guarded) throw new Error('The page has no async part inside its shell');
  try {
    return { tree: await (guarded.type as (props: unknown) => Promise<ReactNode>)(guarded.props) };
  } catch (error) {
    return { error };
  }
}

beforeEach(() => {
  requireServerSession.mockReset().mockResolvedValue({ id: 'u1' });
  getOrderAggregate.mockReset().mockResolvedValue({ ok: true, data: aggregate() });
});

describe('Success page access', () => {
  it('W03 AS-50: the page is a static shell with a skeleton outside the async part', () => {
    const suspense = findSuspense(SuccessPage({ params: Promise.resolve({ orderId: ID }) }));
    expect(suspense).not.toBeNull();
    const { container } = render(<>{suspense?.props.fallback}</>);
    // Nothing async has run: the fallback (heading + status) is what the shell delivers first.
    expect(container.querySelector('h1')).not.toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it.each(['not-a-uuid', '123', '//evil.example', ''])('W03 AS-50: the malformed id %j is not found and nothing is read', async (orderId) => {
    const { error } = await open(orderId);
    expect(error).toBeInstanceOf(NotFound);
    expect(getOrderAggregate).not.toHaveBeenCalled();
  });

  it('W03 AS-50: an unknown order is not found', async () => {
    getOrderAggregate.mockResolvedValue({ ok: false, status: 404, code: 'order_not_found' });
    expect((await open(ID)).error).toBeInstanceOf(NotFound);
  });

  it('W03 AS-50: another member\'s order is not found, the same as an unknown one', async () => {
    getOrderAggregate.mockResolvedValue({ ok: false, status: 404, code: 'order_not_found' });
    expect((await open(ID)).error).toBeInstanceOf(NotFound);
  });

  it('W03 AS-50: an anonymous visitor goes to sign-in with returnTo and no member data is read', async () => {
    requireServerSession.mockImplementation(async (returnTo: string) => {
      throw new Redirected(loginHref(returnTo));
    });
    const { error } = await open(ID);
    expect(requireServerSession).toHaveBeenCalledWith(`/checkout/success/${ID}`);
    expect((error as Redirected).url).toBe(`/login?returnTo=${encodeURIComponent(`/checkout/success/${ID}`)}`);
    expect(getOrderAggregate).not.toHaveBeenCalled();
  });

  it('W03 AS-50: a session that ended between the guard and the read goes to sign-in too', async () => {
    getOrderAggregate.mockResolvedValue({ ok: false, status: 401 });
    const { error } = await open(ID);
    expect((error as Redirected).url).toBe(loginHref(`/checkout/success/${ID}`));
  });

  it.each(['PENDING', 'RESERVED', 'PAID', 'CANCELLED', 'REFUNDED'] as const)(
    'W03 AS-49: a %s order renders the view (no redirect: the view tells the truth) with the order in the query cache',
    async (status) => {
      getOrderAggregate.mockResolvedValue({ ok: true, data: aggregate(status) });
      const { tree, error } = await open(ID);
      expect(error).toBeUndefined();
      render(<QueryClientProvider client={new QueryClient()}>{tree}</QueryClientProvider>);
      expect(getOrderAggregate).toHaveBeenCalledWith(ID);
      expect(screen.getByText(`success view ${ID} cached ${status}`)).toBeInTheDocument();
    },
  );

  it('W03 AS-50: a failed first read still renders the view (the browser reads again)', async () => {
    getOrderAggregate.mockResolvedValue({ ok: false, status: 503 });
    const { tree, error } = await open(ID);
    expect(error).toBeUndefined();
    render(<QueryClientProvider client={new QueryClient()}>{tree}</QueryClientProvider>);
    expect(screen.getByText(`success view ${ID} cached nothing`)).toBeInTheDocument();
  });
});

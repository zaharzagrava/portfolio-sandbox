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

/** The real panel is a client tree with its own tests (UK5); here it only shows what the page handed it. */
vi.mock('@/components/checkout/pay-panel', () => ({
  PayPanel: function PayPanelStub({ orderId }: { orderId: string }) {
    const client = useQueryClient();
    const cached = client.getQueryData<OrderPageResponse>(queryKeys.orders.detail(orderId));
    return (
      <p>
        pay panel {orderId} cached {cached ? cached.order.status : 'nothing'}
      </p>
    );
  },
}));

import PayPage from './page';

const ID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

const aggregate = (status: OrderPageResponse['order']['status'] = 'RESERVED'): OrderPageResponse => ({
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
  const guarded = findGuarded(PayPage({ params: Promise.resolve({ orderId }) }));
  if (!guarded) throw new Error('The page has no async part inside its shell');
  try {
    return { tree: await (guarded.type as (props: unknown) => Promise<ReactNode>)(guarded.props) };
  } catch (error) {
    return { error };
  }
}

function show(tree: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{tree}</QueryClientProvider>);
}

beforeEach(() => {
  requireServerSession.mockReset().mockResolvedValue({ id: 'u1' });
  getOrderAggregate.mockReset().mockResolvedValue({ ok: true, data: aggregate() });
});

describe('Pay page access', () => {
  it('W03 AS-35: the page is a static shell with a heading and a skeleton outside the async part', () => {
    const suspense = findSuspense(PayPage({ params: Promise.resolve({ orderId: ID }) }));
    expect(suspense).not.toBeNull();
    const { container } = render(<>{suspense?.props.fallback}</>);
    // Nothing async has run: the fallback (heading + status) is what the shell delivers first.
    expect(container.querySelector('h1')).not.toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it.each(['not-a-uuid', '123', '//evil.example', ''])('W03 AS-35: the malformed id %j is not found and nothing is read', async (orderId) => {
    const { error } = await open(orderId);
    expect(error).toBeInstanceOf(NotFound);
    expect(getOrderAggregate).not.toHaveBeenCalled();
  });

  it('W03 AS-35: an unknown order is not found', async () => {
    getOrderAggregate.mockResolvedValue({ ok: false, status: 404, code: 'order_not_found' });
    expect((await open(ID)).error).toBeInstanceOf(NotFound);
  });

  it('W03 AS-35: another member\'s order is the same not-found (the API answers 404, never a 403 form)', async () => {
    getOrderAggregate.mockResolvedValue({ ok: false, status: 404, code: 'order_not_found' });
    const foreign = await open(ID);
    getOrderAggregate.mockResolvedValue({ ok: false, status: 404 });
    const unknown = await open(ID);
    expect(foreign.error).toBeInstanceOf(NotFound);
    expect(unknown.error).toBeInstanceOf(NotFound);
  });

  it('W03 AS-35: an anonymous visitor goes to sign-in with returnTo and no member data is read', async () => {
    requireServerSession.mockImplementation(async (returnTo: string) => {
      throw new Redirected(loginHref(returnTo));
    });
    const { error } = await open(ID);
    expect(requireServerSession).toHaveBeenCalledWith(`/checkout/pay/${ID}`);
    expect(error).toBeInstanceOf(Redirected);
    expect((error as Redirected).url).toBe(`/login?returnTo=${encodeURIComponent(`/checkout/pay/${ID}`)}`);
    expect(getOrderAggregate).not.toHaveBeenCalled();
  });

  it('W03 AS-35: a session that ended between the guard and the read goes to sign-in too', async () => {
    getOrderAggregate.mockResolvedValue({ ok: false, status: 401, code: 'unauthenticated' });
    const { error } = await open(ID);
    expect(error).toBeInstanceOf(Redirected);
    expect((error as Redirected).url).toBe(loginHref(`/checkout/pay/${ID}`));
  });

  it.each(['PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED'] as const)('W03 AS-35: a %s order redirects to the success page', async (status) => {
    getOrderAggregate.mockResolvedValue({ ok: true, data: aggregate(status) });
    const { error } = await open(ID);
    expect(error).toBeInstanceOf(Redirected);
    expect((error as Redirected).url).toBe(`/checkout/success/${ID}`);
  });

  it.each(['PENDING', 'RESERVED', 'CANCELLED', 'REFUNDED'] as const)('W03 AS-35: a %s order renders the pay panel with the order already in the query cache', async (status) => {
    getOrderAggregate.mockResolvedValue({ ok: true, data: aggregate(status) });
    const { tree, error } = await open(ID);
    expect(error).toBeUndefined();
    show(tree);
    expect(getOrderAggregate).toHaveBeenCalledWith(ID);
    expect(screen.getByText(`pay panel ${ID} cached ${status}`)).toBeInTheDocument();
  });

  it('W03 AS-35: a failed first read still renders the panel (the browser reads again and shows its own error)', async () => {
    getOrderAggregate.mockResolvedValue({ ok: false, status: 503 });
    const { tree, error } = await open(ID);
    expect(error).toBeUndefined();
    show(tree);
    expect(screen.getByText(`pay panel ${ID} cached nothing`)).toBeInTheDocument();
  });

  it('W03 AS-70: the guard runs before the first read', async () => {
    const calls: string[] = [];
    requireServerSession.mockImplementation(async () => {
      calls.push('guard');
      return { id: 'u1' };
    });
    getOrderAggregate.mockImplementation(async () => {
      calls.push('read');
      return { ok: true, data: aggregate() };
    });
    await open(ID);
    expect(calls).toEqual(['guard', 'read']);
  });
});

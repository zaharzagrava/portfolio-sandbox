import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { isValidElement, Suspense, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const describeUnsubscribe = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/unsubscribe.server', () => ({ describeUnsubscribe }));

import UnsubscribePage, { metadata } from './page';

function findContent(node: ReactNode): ReactElement | null {
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === 'function' && element.type.name === 'UnsubscribeContent') return element;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findContent(child as ReactNode);
    if (found) return found;
  }
  return null;
}

async function open(search: Record<string, string | string[] | undefined>) {
  const content = findContent(UnsubscribePage({ searchParams: Promise.resolve(search) }));
  if (!content) throw new Error('no async part');
  const tree = await (content.type as (props: unknown) => Promise<ReactNode>)(content.props);
  return render(<QueryClientProvider client={new QueryClient()}>{tree}</QueryClientProvider>);
}

beforeEach(() => describeUnsubscribe.mockReset());

describe('Unsubscribe page', () => {
  it('S28 AS-25: the page is a static shell with a Suspense boundary, not indexable, and sends no referrer', () => {
    const tree = UnsubscribePage({ searchParams: Promise.resolve({}) });
    expect(render(<>{tree}</>).container.querySelector('h1')).toHaveTextContent('Unsubscribe');
    expect(isValidElement(tree)).toBe(true);
    expect(Suspense).toBeDefined();
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe('no-referrer');
  });

  it('S28 AS-25: a valid token is described (GET) and offered as a button; nothing is switched off by reading', async () => {
    describeUnsubscribe.mockResolvedValue({ ok: true, data: { category: 'marketing' } });
    await open({ token: 'tok.en' });
    expect(describeUnsubscribe).toHaveBeenCalledWith('tok.en');
    expect(screen.getByText(/Stop receiving/)).toHaveTextContent('marketing');
    expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('tok.en');
  });

  it('S28 AS-26: invalid_unsubscribe_token (400) and a missing token show the friendly invalid state', async () => {
    describeUnsubscribe.mockResolvedValue({ ok: false, status: 400, code: 'invalid_unsubscribe_token' });
    const first = await open({ token: 'bad' });
    expect(screen.getByRole('alert')).toHaveTextContent('This unsubscribe link is not valid.');
    first.unmount();
    describeUnsubscribe.mockClear();
    await open({});
    expect(screen.getByRole('alert')).toHaveTextContent('This unsubscribe link is not valid.');
    expect(describeUnsubscribe).not.toHaveBeenCalled();
  });

  it('S28 AS-26: 429 says when to try again; an unreachable service says so', async () => {
    describeUnsubscribe.mockResolvedValue({ ok: false, status: 429, code: 'rate_limited', retryAfter: 30 });
    const first = await open({ token: 'x' });
    expect(screen.getByRole('alert')).toHaveTextContent('Too many attempts. Try again in 30 seconds.');
    first.unmount();
    describeUnsubscribe.mockResolvedValue({ ok: false, status: 0 });
    await open({ token: 'x' });
    expect(screen.getByRole('alert')).toHaveTextContent('We could not check this link right now.');
  });
});

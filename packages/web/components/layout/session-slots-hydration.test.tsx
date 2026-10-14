import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/' }));

import { MobileLoginLink } from '@/components/auth/account-menu';
import { queryKeys } from '@/lib/query-keys';
import { MemberOnly } from './member-only';

const member = { id: 'u1', email: 'a@example.com', role: 'member' };

function tree(session: typeof member | null | undefined, children: React.ReactNode) {
  const client = new QueryClient();
  if (session !== undefined) client.setQueryData(queryKeys.auth.session(), session);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const visitorSlot = (session?: typeof member | null) => tree(session, <MobileLoginLink initialAnonymous />);
const memberSlot = (session?: typeof member | null) =>
  tree(
    session,
    <MemberOnly initialMember>
      <p>bell</p>
    </MemberOnly>,
  );

/** The server's markup (session known there) hydrated by a browser whose cache is still empty: no mismatch, no change. */
function hydrates(server: React.ReactElement, browser: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.innerHTML = renderToString(server);
  const before = container.innerHTML;
  const errors: unknown[] = [];
  let root!: ReturnType<typeof hydrateRoot>;
  act(() => {
    root = hydrateRoot(container, browser, { onRecoverableError: (error) => errors.push(error) });
  });
  const after = container.innerHTML;
  act(() => root.unmount());
  container.remove();
  return { errors, before, after };
}

// React Query batches notifications with a zero-delay timer; let it fire before the environment is torn down.
afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

// The server may or may not have the session in its query cache when it renders the header (the bootstrap streams in its own
// boundary) while the browser's first render never has it yet. The server tells the slots what it knows by a prop, so both
// render the same markup.
describe('W07 header slots that follow the session hydrate cleanly (AS-01)', () => {
  it('W07 AS-01: the visitor log-in icon is in the server markup when the server read an anonymous visitor', () => {
    expect(renderToString(visitorSlot())).toContain('aria-label="Log in"');
    expect(renderToString(visitorSlot(null))).toContain('aria-label="Log in"');
  });

  it('W07 AS-01: the member bell slot is in the server markup when the server read a member', () => {
    expect(renderToString(memberSlot())).toContain('<p>bell</p>');
    expect(renderToString(memberSlot(member))).toContain('<p>bell</p>');
  });

  it('W07 AS-01: the browser hydrates the log-in icon without a mismatch whether or not the server cache had the session', () => {
    for (const serverCache of [undefined, null] as const) {
      const result = hydrates(visitorSlot(serverCache), visitorSlot());
      expect(result.errors).toEqual([]);
      expect(result.after).toBe(result.before);
    }
  });

  it('W07 AS-01: the browser hydrates the bell slot without a mismatch whether or not the server cache had the session', () => {
    for (const serverCache of [undefined, member] as const) {
      const result = hydrates(memberSlot(serverCache), memberSlot());
      expect(result.errors).toEqual([]);
      expect(result.after).toBe(result.before);
    }
  });

  it('W07 AS-01: once the browser knows the session it overrides what the server said (sign-out, sign-in elsewhere)', () => {
    render(tree(member, <MobileLoginLink initialAnonymous />));
    expect(screen.queryByRole('link', { name: 'Log in' })).toBeNull();
    render(tree(null, <MemberOnly initialMember><p>bell-gone</p></MemberOnly>));
    expect(screen.queryByText('bell-gone')).toBeNull();
  });

  it('W07 AS-01: without a hint from the server nothing is shown until the session is known', () => {
    expect(renderToString(tree(undefined, <MobileLoginLink />))).toBe('');
    expect(renderToString(tree(undefined, <MemberOnly><p>bell</p></MemberOnly>))).toBe('');
  });
});

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentifyResult } from '@/lib/api/widget';
import { CheckoutApp } from './checkout-app';

const HOST = 'https://www.my-shop.com';
const KEY = 'pk_live_abcdefghijklmnopqrstuvwx';
const FAILURE = "We couldn't open checkout. Close this window and try again.";

let parent: { postMessage: ReturnType<typeof vi.fn> };

const identified = (email: string | null): IdentifyResult => ({ ok: true, customer: { id: 'cust-42', email }, widgetToken: 'w.t' });

function setup(options: { identify?: (key: string, token: string) => Promise<IdentifyResult>; hostOrigin?: string | null; timeoutMs?: number } = {}) {
  const identify = options.identify ?? vi.fn(async () => identified('buyer@example.com'));
  const view = render(
    <CheckoutApp
      siteKey={KEY}
      hostOrigin={options.hostOrigin === undefined ? HOST : options.hostOrigin}
      parent={parent as unknown as Window}
      identify={identify}
      identityTimeoutMs={options.timeoutMs}
    />,
  );
  return { identify, ...view };
}

const hostSays = (data: unknown, overrides: { origin?: string; source?: unknown } = {}) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin: overrides.origin ?? HOST, source: (overrides.source ?? parent) as MessageEventSource }));
  });

beforeEach(() => {
  parent = { postMessage: vi.fn() };
});
afterEach(() => vi.useRealTimers());

describe('W07 widget checkout application (AS-40)', () => {
  it('W07 AS-40: starts in "Checking your details…" (aria-busy) and asks the host page for the identity, once, to the registered origin', () => {
    setup();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Checking your details…');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(parent.postMessage.mock.calls).toEqual([[{ type: 'marketplace:need-identity' }, HOST]]);
  });

  it('W07 AS-40: development double mounting still asks once', () => {
    render(
      <StrictMode>
        <CheckoutApp siteKey={KEY} hostOrigin={HOST} parent={parent as unknown as Window} identify={vi.fn()} />
      </StrictMode>,
    );
    expect(parent.postMessage.mock.calls.filter(([message]) => message.type === 'marketplace:need-identity')).toHaveLength(1);
  });

  it('W07 AS-40: a token from the host is exchanged and the customer is shown as text: "Signed in as {email}"', async () => {
    const { identify } = setup({ identify: vi.fn(async () => identified('<img src=x onerror=alert(1)>@example.com')) });
    hostSays({ type: 'marketplace:identity', token: 'handoff-token' });
    expect(await screen.findByText('Signed in as <img src=x onerror=alert(1)>@example.com')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(identify).toHaveBeenCalledWith(KEY, 'handoff-token');
    expect(screen.getByRole('status')).not.toHaveAttribute('aria-busy', 'true');
  });

  it('W07 AS-40: a customer without an e-mail is shown as signed in', async () => {
    setup({ identify: vi.fn(async () => identified(null)) });
    hostSays({ type: 'marketplace:identity', token: 'handoff-token' });
    expect(await screen.findByText('Signed in')).toBeInTheDocument();
  });

  it('W07 AS-40: no token from the host means "Continue as guest", and identify is never called', async () => {
    const { identify } = setup();
    hostSays({ type: 'marketplace:identity', token: null });
    expect(await screen.findByText('Continue as guest')).toBeInTheDocument();
    expect(identify).not.toHaveBeenCalled();
  });

  it('W07 AS-40: a host that never answers (no hook) leaves the visitor as a guest after the wait', async () => {
    vi.useFakeTimers();
    setup({ timeoutMs: 7000 });
    expect(screen.getByRole('status')).toHaveTextContent('Checking your details…');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7001);
    });
    expect(screen.getByText('Continue as guest')).toBeInTheDocument();
  });

  it.each([[422], [410], [403], [404]])('W07 AS-40: identify answering %i shows the one failure text', async (status) => {
    setup({ identify: vi.fn(async () => ({ ok: false as const, status })) });
    hostSays({ type: 'marketplace:identity', token: 'handoff-token' });
    expect(await screen.findByText(FAILURE)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(FAILURE);
    expect(screen.queryByText(/422|410|403|404/)).toBeNull();
  });

  it('W07 AS-40: a network failure of identify shows the same text', async () => {
    setup({ identify: vi.fn(async () => ({ ok: false as const, status: 0 })) });
    hostSays({ type: 'marketplace:identity', token: 'handoff-token' });
    expect(await screen.findByText(FAILURE)).toBeInTheDocument();
  });

  it('W07 AS-40: messages from another window, another origin or with a malformed body are ignored', async () => {
    const { identify } = setup();
    hostSays({ type: 'marketplace:identity', token: 'evil' }, { origin: 'https://evil.example' });
    hostSays({ type: 'marketplace:identity', token: 'evil' }, { source: { postMessage: vi.fn() } });
    hostSays({ type: 'marketplace:identity', token: 123 });
    hostSays('marketplace:identity');
    expect(screen.getByRole('status')).toHaveTextContent('Checking your details…');
    expect(identify).not.toHaveBeenCalled();
  });

  it('W07 AS-40: an unknown host origin shows the failure text and posts nothing', () => {
    setup({ hostOrigin: null });
    expect(screen.getByText(FAILURE)).toBeInTheDocument();
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it('W07 AS-40: Close and Escape post marketplace:close to the registered origin', async () => {
    const user = userEvent.setup();
    setup();
    parent.postMessage.mockClear();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.keyboard('{Escape}');
    expect(parent.postMessage.mock.calls).toEqual([
      [{ type: 'marketplace:close' }, HOST],
      [{ type: 'marketplace:close' }, HOST],
    ]);
  });

  it('W07 AS-40: the Close button is reachable in the failure state too', async () => {
    const user = userEvent.setup();
    setup({ identify: vi.fn(async () => ({ ok: false as const, status: 403 })) });
    hostSays({ type: 'marketplace:identity', token: 'handoff-token' });
    await screen.findByText(FAILURE);
    parent.postMessage.mockClear();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'marketplace:close' }, HOST);
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { toast } from 'sonner';
import { SignInMethodsPanel } from './sign-in-methods-panel';

const origin = 'http://localhost:3000';
const GOOGLE = { id: '8b0c6c1e-6f43-4a0e-9a0a-0d3a3c5f6a11', provider: 'google', email: 'me@gmail.com', linkedAt: '2026-04-02T10:00:00.000Z' };
const OTHER = { id: '1f1a9a52-5b79-4a3e-8f0b-6a2b1f0d9c22', provider: 'github', email: null, linkedAt: '2026-04-03T10:00:00.000Z' };
const AUTH_URL = 'https://accounts.example.test/o/oauth2/auth?state=abc';

let identities: unknown[];
let providers: unknown[];
let mfa: { state: string };

function stubs() {
  server.use(
    http.get(`${origin}/api/auth/identities`, () => HttpResponse.json(identities)),
    http.get(`${origin}/api/auth/oidc/providers`, () => HttpResponse.json(providers)),
    http.get(`${origin}/api/auth/mfa`, () => HttpResponse.json(mfa)),
  );
}

function mount(props: Partial<{ oidcEnabled: boolean; linked: string; error: string }> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SignInMethodsPanel oidcEnabled {...props} />
    </QueryClientProvider>,
  );
}

describe('SignInMethodsPanel', () => {
  beforeEach(() => {
    identities = [];
    providers = [{ id: 'google', displayName: 'Google' }];
    mfa = { state: 'none' };
    stubs();
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('W01 AS-61: lists linked identities with provider, e-mail or "No e-mail shared", and the link date', async () => {
    identities = [GOOGLE, OTHER];
    mount({ oidcEnabled: false });
    expect(await screen.findByText('me@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('No e-mail shared')).toBeInTheDocument();
    expect(screen.getAllByText(/^Linked .*2026$/)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^Unlink/ })).toHaveLength(2);
  });

  it('W01 AS-61: empty state', async () => {
    mount({ oidcEnabled: false });
    expect(await screen.findByText('No sign-in methods linked yet.')).toBeInTheDocument();
  });

  it('W01 AS-61: nothing about Google is rendered and no OIDC request is made while it is switched off', async () => {
    const asked: string[] = [];
    server.use(http.get(`${origin}/api/auth/oidc/providers`, () => (asked.push('providers'), HttpResponse.json(providers))));
    mount({ oidcEnabled: false });
    await screen.findByText('No sign-in methods linked yet.');
    expect(screen.queryByRole('button', { name: 'Link Google' })).toBeNull();
    expect(asked).toEqual([]);
  });

  it('W01 AS-61: Link Google is not rendered when the provider list lacks google', async () => {
    providers = [];
    mount();
    await screen.findByText('No sign-in methods linked yet.');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Link Google' })).toBeNull());
  });

  it('W01 AS-61: Link Google without two-step starts the link and navigates to authorizationUrl', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const bodies: unknown[] = [];
    server.use(
      http.post(`${origin}/api/auth/oidc/google/link/start`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ authorizationUrl: AUTH_URL });
      }),
    );
    mount();
    await user.click(await screen.findByRole('button', { name: 'Link Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTH_URL));
    expect(bodies).toEqual([{ returnTo: '/account/security?tab=methods' }]);
  });

  it('W01 AS-61: with two-step on, Link Google asks for a code first, then navigates; a wrong code stays in the dialog', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mfa = { state: 'enabled' };
    const bodies: unknown[] = [];
    let attempt = 0;
    server.use(
      http.post(`${origin}/api/auth/oidc/google/link/start`, async ({ request }) => {
        bodies.push(await request.json());
        return ++attempt === 1 ? HttpResponse.json({ code: 'invalid_code' }, { status: 422 }) : HttpResponse.json({ authorizationUrl: AUTH_URL });
      }),
    );
    mount();
    await user.click(await screen.findByRole('button', { name: 'Link Google' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Authentication code'), '111111');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText("That code isn't right. Check your authenticator app and try again.")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText('Authentication code'), '222222');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTH_URL));
    expect(bodies).toEqual([
      { returnTo: '/account/security?tab=methods', code: '111111' },
      { returnTo: '/account/security?tab=methods', code: '222222' },
    ]);
  });

  it('W01 AS-61: ?linked=google shows the banner', async () => {
    mount({ linked: 'google' });
    expect(await screen.findByText('Google account linked.')).toBeInTheDocument();
  });

  it('W01 AS-61: ?error=link_conflict shows the provider-error copy', async () => {
    mount({ error: 'link_conflict' });
    expect(await screen.findByRole('alert')).toHaveTextContent('This account already has a Google sign-in linked, or that address belongs to a different one.');
  });

  it('W01 AS-61: an unknown ?error is ignored', async () => {
    mount({ error: '<img src=x>' });
    await screen.findByText('No sign-in methods linked yet.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('W01 AS-61: Unlink 204 removes the row', async () => {
    const user = userEvent.setup();
    identities = [GOOGLE, OTHER];
    server.use(http.delete(`${origin}/api/auth/identities/:id`, () => new HttpResponse(null, { status: 204 })));
    mount({ oidcEnabled: false });
    await screen.findByText('me@gmail.com');
    await user.click(screen.getAllByRole('button', { name: /^Unlink/ })[0]);
    await waitFor(() => expect(screen.queryByText('me@gmail.com')).toBeNull());
    expect(screen.getByText('No e-mail shared')).toBeInTheDocument();
  });

  it('W01 AS-61: Unlink 404 identity_not_found removes the row silently', async () => {
    const user = userEvent.setup();
    identities = [GOOGLE];
    server.use(http.delete(`${origin}/api/auth/identities/:id`, () => HttpResponse.json({ code: 'identity_not_found' }, { status: 404 })));
    mount({ oidcEnabled: false });
    await user.click(await screen.findByRole('button', { name: /^Unlink/ }));
    await waitFor(() => expect(screen.queryByText('me@gmail.com')).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('W01 AS-61: Unlink 409 last_login_method keeps the row and explains', async () => {
    const user = userEvent.setup();
    identities = [GOOGLE];
    server.use(http.delete(`${origin}/api/auth/identities/:id`, () => HttpResponse.json({ code: 'last_login_method' }, { status: 409 })));
    mount({ oidcEnabled: false });
    await user.click(await screen.findByRole('button', { name: /^Unlink/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This is your only way to sign in. Add another sign-in method first.');
    expect(screen.getByText('me@gmail.com')).toBeInTheDocument();
  });
});

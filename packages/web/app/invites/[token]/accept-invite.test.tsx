import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BFF_COOKIES } from '@marketplace-sandbox/contracts';
import { server } from '../../../vitest.setup';
import { SELLER_SHOP_ID } from '@/lib/test/seller-handlers';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const replace = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/invites/TOKEN',
  useSearchParams: () => new URLSearchParams(),
}));

const jar: Record<string, string> = {};
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock('@/lib/server/endpoints.server', () => ({ bffUrl: () => 'http://bff.test' }));

const requireServerSession = vi.fn();
vi.mock('@/lib/auth/session.server', () => ({ requireServerSession: (returnTo: string) => requireServerSession(returnTo) }));

import { AcceptInvite } from './accept-invite';
import { acceptInviteAction } from './actions';
import { InviteGate } from './invite-gate';

const TOKEN = 'inv_SECRETtokenvalue1234567890';
const accepted = (over: Record<string, unknown> = {}) => ({ ok: true as const, shopId: SELLER_SHOP_ID, role: 'STAFF' as const, alreadyMember: false, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of Object.keys(jar)) delete jar[name];
});
afterEach(() => vi.restoreAllMocks());

describe('W04 accept invitation page', () => {
  it('W04 AS-80: the page invites and Accept invitation calls the action once, toasts the role and replaces history with the shop', async () => {
    const accept = vi.fn(async () => accepted());
    const user = userEvent.setup();
    render(<AcceptInvite accept={accept} />);
    expect(screen.getByText("You've been invited to join a shop.")).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Accept invitation' });
    await user.dblClick(button);
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/dashboard/seller/${SELLER_SHOP_ID}`));
    expect(accept).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('You joined as Staff.');
    expect(push).not.toHaveBeenCalled();
  });

  it('W04 AS-80: alreadyMember toasts "You\'re already a member."', async () => {
    const user = userEvent.setup();
    render(<AcceptInvite accept={async () => accepted({ alreadyMember: true })} />);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("You're already a member."));
    expect(replace).toHaveBeenCalledWith(`/dashboard/seller/${SELLER_SHOP_ID}`);
  });

  it('W04 AS-81: a refusal reads the same wherever it comes from, with a link to the dashboard, and nothing navigates', async () => {
    const user = userEvent.setup();
    render(<AcceptInvite accept={async () => ({ ok: false as const, code: 'invite_not_found' })} />);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText("This invitation isn't valid for this account. It may have expired, been used, or been sent to a different e-mail address.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to your dashboard' })).toHaveAttribute('href', '/dashboard/seller');
    expect(replace).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('W04 AS-81: 429 shows the countdown message and the button waits', async () => {
    const user = userEvent.setup();
    render(<AcceptInvite accept={async () => ({ ok: false as const, code: 'rate_limited', retryAfter: 20 })} />);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByText('Too many requests. Try again in 20 s.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeDisabled());
    expect(screen.queryByRole('link', { name: 'Go to your dashboard' })).not.toBeInTheDocument();
  });

  it('W04 AS-82: the client never holds the token: it is not in the markup, the console or the toast', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const user = userEvent.setup();
    const { container } = render(<AcceptInvite accept={async () => accepted()} />);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(JSON.stringify(vi.mocked(toast.success).mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(TOKEN);
  });
});

describe('W04 acceptInviteAction', () => {
  const accept = 'http://bff.test/api/bff/f/shop-invites/accept';

  it('W04 AS-80: posts {token} with the session and CSRF cookies and returns the shop and role', async () => {
    jar[BFF_COOKIES.session] = 'sess';
    jar[BFF_COOKIES.csrf] = 'csrf-1';
    let seen: Request | undefined;
    let body: unknown;
    server.use(http.post(accept, async ({ request }) => ((seen = request.clone()), (body = await request.json()), HttpResponse.json({ shopId: SELLER_SHOP_ID, role: 'STAFF' }, { status: 201 }))));
    const result = await acceptInviteAction(TOKEN);
    expect(result).toEqual({ ok: true, shopId: SELLER_SHOP_ID, role: 'STAFF', alreadyMember: false });
    expect(body).toEqual({ token: TOKEN });
    expect(seen?.headers.get('x-csrf-token')).toBe('csrf-1');
    expect(seen?.headers.get('cookie')).toContain(`${BFF_COOKIES.session}=sess`);
  });

  it('W04 AS-80: an existing member comes back as alreadyMember', async () => {
    jar[BFF_COOKIES.session] = 'sess';
    jar[BFF_COOKIES.csrf] = 'c';
    server.use(http.post(accept, () => HttpResponse.json({ shopId: SELLER_SHOP_ID, role: 'OWNER', alreadyMember: true })));
    expect(await acceptInviteAction(TOKEN)).toMatchObject({ ok: true, alreadyMember: true, role: 'OWNER' });
  });

  it.each([404, 400, 403, 410, 422])('W04 AS-81: a %s answer is the one refusal, invite_not_found, whatever the API says', async (status) => {
    jar[BFF_COOKIES.session] = 'sess';
    jar[BFF_COOKIES.csrf] = 'c';
    server.use(http.post(accept, () => HttpResponse.json({ code: 'invite_expired', title: 'expired' }, { status })));
    expect(await acceptInviteAction(TOKEN)).toEqual({ ok: false, code: 'invite_not_found' });
  });

  it('W04 AS-81: 429 carries retryAfter; 401 and a missing session are unauthenticated; a broken API is service_unavailable', async () => {
    jar[BFF_COOKIES.session] = 'sess';
    jar[BFF_COOKIES.csrf] = 'c';
    server.use(http.post(accept, () => HttpResponse.json({ code: 'rate_limited' }, { status: 429, headers: { 'retry-after': '17' } })));
    expect(await acceptInviteAction(TOKEN)).toEqual({ ok: false, code: 'rate_limited', retryAfter: 17 });
    server.use(http.post(accept, () => HttpResponse.json({ code: 'unauthenticated' }, { status: 401 })));
    expect(await acceptInviteAction(TOKEN)).toEqual({ ok: false, code: 'unauthenticated' });
    server.use(http.post(accept, () => HttpResponse.json({}, { status: 503 })));
    expect(await acceptInviteAction(TOKEN)).toEqual({ ok: false, code: 'service_unavailable' });
    delete jar[BFF_COOKIES.session];
    expect(await acceptInviteAction(TOKEN)).toEqual({ ok: false, code: 'unauthenticated' });
  });

  it('W04 AS-82: a malformed token is refused without a request', async () => {
    jar[BFF_COOKIES.session] = 'sess';
    jar[BFF_COOKIES.csrf] = 'c';
    const sent = vi.fn();
    server.use(http.post(accept, () => (sent(), HttpResponse.json({}))));
    expect(await acceptInviteAction('')).toEqual({ ok: false, code: 'invite_not_found' });
    expect(await acceptInviteAction('x'.repeat(5000))).toEqual({ ok: false, code: 'invite_not_found' });
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('W04 invite gate', () => {
  it('W04 AS-80: a signed-out visitor is sent to sign-in with returnTo /invites/{token}', async () => {
    requireServerSession.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(InviteGate({ params: Promise.resolve({ token: TOKEN }) })).rejects.toThrow('NEXT_REDIRECT');
    expect(requireServerSession).toHaveBeenCalledWith(`/invites/${TOKEN}`);
  });

  it('W04 AS-82: a signed-in visitor gets the accept component with a bound action, not the token', async () => {
    requireServerSession.mockResolvedValue({ id: 'u' });
    const element = await InviteGate({ params: Promise.resolve({ token: TOKEN }) });
    expect(JSON.stringify(element.props)).not.toContain(TOKEN);
    expect(typeof element.props.accept).toBe('function');
  });
});

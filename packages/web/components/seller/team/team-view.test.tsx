import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { readTeamParams } from '@/lib/seller/search-params';
import { origin, SELLER_SHOP_ID, sellerProblem, shopFixture, VIEWER_PERMISSIONS, type SellerProblemCode } from '@/lib/test/seller-handlers';
import { TeamView } from './team-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SELF = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ADMIN = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const STAFF = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const VIEWER = '3d4e5f6a-7b8c-4d9e-8f10-2b3c4d5e6f70';
const INVITE_1 = '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d';
const INVITE_2 = '6c7d8e9f-0a12-4b3c-8d4e-5f6a7b8c9d0e';

let authUser = SELF;
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: authUser, email: 'x@example.com', role: 'seller' }, status: 'authenticated', isAuthenticated: true, isLoading: false }),
}));

const push = vi.fn();
const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/team`,
  useSearchParams: () => new URLSearchParams(search),
}));

const PATH = `/dashboard/seller/${SELLER_SHOP_ID}/team`;
const shopUrl = `${origin}/api/shops/${SELLER_SHOP_ID}`;
const member = (userId: string, email: string | null, role: string, source = 'invite') => ({ userId, email, role, source, joinedAt: '2026-10-01T09:00:00.000Z' });
const MEMBERS = [member(SELF, 'owner@example.com', 'OWNER', 'owner'), member(ADMIN, 'admin@example.com', 'ADMIN'), member(STAFF, 'staff@example.com', 'STAFF'), member(VIEWER, null, 'VIEWER', 'sso')];
const invite = (id: string, email: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  email,
  role: 'STAFF',
  status,
  invitedBy: SELF,
  expiresAt: '2026-10-24T09:00:00.000Z',
  createdAt: '2026-10-17T09:00:00.000Z',
  ...over,
});

let client: QueryClient;
let membersReads = 0;
let membersNext: string | null = null;
function show(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(
    http.get(shopUrl, () => HttpResponse.json(shop)),
    http.get(`${shopUrl}/members`, () => (membersReads++, HttpResponse.json({ items: MEMBERS, nextCursor: membersNext }))),
  );
  return render(
    <QueryClientProvider client={client}>
      <TeamView shopId={SELLER_SHOP_ID} serverParams={readTeamParams(Object.fromEntries(new URLSearchParams(search)))} />
    </QueryClientProvider>,
  );
}

const rowOf = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

async function chooseFromMenu(user: ReturnType<typeof userEvent.setup>, label: string, item: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${label}` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  search = '';
  authUser = SELF;
  membersReads = 0;
  membersNext = null;
  vi.clearAllMocks();
});

describe('W04 team members', () => {
  it('W04 AS-74: a table with Member, Role, Joined, Source lists the members; the viewer is marked (you); no e-mail reads Unknown member', async () => {
    show();
    const table = await screen.findByRole('table', { name: /members/i });
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(expect.arrayContaining(['Member', 'Role', 'Joined', 'Source']));
    expect(within(table).getByText('owner@example.com (you)')).toBeInTheDocument();
    expect(within(table).queryByText('admin@example.com (you)')).not.toBeInTheDocument();
    expect(within(table).getByText('Unknown member')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Members' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Invitations' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Roles' })).toBeInTheDocument();
  });

  it('W04 AS-74: choosing a tab puts it in the URL; without members.manage there is no Invitations tab', async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('tab', { name: 'Roles' }));
    expect(push).toHaveBeenCalledWith(`${PATH}?tab=roles`);
    await screen.findByRole('table', { name: /members/i });
  });

  it('W04 AS-79: a viewer sees Members and Roles only', async () => {
    authUser = VIEWER;
    show(shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }));
    await screen.findByRole('table', { name: /members/i });
    expect(screen.queryByRole('tab', { name: 'Invitations' })).not.toBeInTheDocument();
    // Only the viewer's own row has an action ("Leave shop").
    expect(screen.getAllByRole('button', { name: /^Actions for/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Actions for Unknown member' })).toBeInTheDocument();
  });

  it('W04 AS-75: an owner changes a role from the row menu: PATCH {role}, toast "Role updated"', async () => {
    const bodies: unknown[] = [];
    server.use(http.patch(`${shopUrl}/members/${STAFF}`, async ({ request }) => (bodies.push(await request.json()), new HttpResponse(null, { status: 204 }))));
    const user = userEvent.setup();
    show();
    await chooseFromMenu(user, 'staff@example.com', 'Change role to Admin');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Role updated'));
    expect(bodies).toEqual([{ role: 'ADMIN' }]);
  });

  it('W04 AS-75: an admin may change staff and viewers only, and has no menu on the owner row', async () => {
    authUser = ADMIN;
    show(shopFixture({ myRole: 'ADMIN' }));
    const user = userEvent.setup();
    await screen.findByRole('table', { name: /members/i });
    expect(screen.queryByRole('button', { name: 'Actions for owner@example.com' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions for staff@example.com' }));
    expect(await screen.findByRole('menuitem', { name: 'Change role to Viewer' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Change role to Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Change role to Owner' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Remove member' })).toBeInTheDocument();
  });

  it.each([
    ['insufficient_role', "You can't change this member's role."],
    ['last_owner', 'A shop needs at least one owner.'],
  ] as [SellerProblemCode, string][])('W04 AS-75: %s shows its fixed message, never the server text', async (code, text) => {
    server.use(http.patch(`${shopUrl}/members/${STAFF}`, () => sellerProblem(code)));
    const user = userEvent.setup();
    show();
    await chooseFromMenu(user, 'staff@example.com', 'Change role to Viewer');
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText(/Server title|Server detail/)).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('W04 AS-75: member_not_found refetches the list', async () => {
    server.use(http.patch(`${shopUrl}/members/${STAFF}`, () => sellerProblem('member_not_found')));
    const user = userEvent.setup();
    show();
    await screen.findByRole('table', { name: /members/i });
    const before = membersReads;
    await chooseFromMenu(user, 'staff@example.com', 'Change role to Viewer');
    await waitFor(() => expect(membersReads).toBeGreaterThan(before));
  });

  it('W04 AS-76: removing a member asks first ("Remove {email}"), then DELETE and toast "Member removed"', async () => {
    const calls: string[] = [];
    server.use(http.delete(`${shopUrl}/members/${STAFF}`, () => (calls.push('DELETE'), new HttpResponse(null, { status: 204 }))));
    const user = userEvent.setup();
    show();
    await chooseFromMenu(user, 'staff@example.com', 'Remove member');
    const dialog = await screen.findByRole('dialog', { name: 'Remove staff@example.com' });
    expect(calls).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Member removed'));
    expect(calls).toEqual(['DELETE']);
  });

  it('W04 AS-76: "Leave shop" is on the viewer\'s own row only; confirming goes to /dashboard/seller', async () => {
    const calls: string[] = [];
    server.use(http.delete(`${shopUrl}/members/${SELF}`, () => (calls.push('DELETE'), new HttpResponse(null, { status: 204 }))), http.get(`${origin}/api/shops/mine`, () => HttpResponse.json({ items: [], nextCursor: null })));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Actions for staff@example.com' }));
    expect(screen.queryByRole('menuitem', { name: 'Leave shop' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await chooseFromMenu(user, 'owner@example.com', 'Leave shop');
    const dialog = await screen.findByRole('dialog', { name: 'Leave shop' });
    await user.click(within(dialog).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/seller'));
    expect(calls).toEqual(['DELETE']);
  });

  it('W04 AS-76: last_owner on leaving shows the message in the dialog and keeps it open', async () => {
    server.use(http.delete(`${shopUrl}/members/${SELF}`, () => sellerProblem('last_owner')));
    const user = userEvent.setup();
    show();
    await chooseFromMenu(user, 'owner@example.com', 'Leave shop');
    const dialog = await screen.findByRole('dialog', { name: 'Leave shop' });
    await user.click(within(dialog).getByRole('button', { name: 'Leave' }));
    expect(await within(dialog).findByText('A shop needs at least one owner.')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('W04 AS-74: Next page carries the cursor of the members list', async () => {
    membersNext = 'm2';
    show();
    expect(await screen.findByRole('link', { name: 'Next page' })).toHaveAttribute('href', `${PATH}?cursor=m2`);
  });
});

describe('W04 team invitations', () => {
  const invites = `${shopUrl}/invites`;
  const listInvites = (items: ReturnType<typeof invite>[], nextCursor: string | null = null) => http.get(invites, () => HttpResponse.json({ items, nextCursor }));

  beforeEach(() => {
    search = 'tab=invitations';
  });

  it('W04 AS-77: the e-mail and role (no Owner) are sent; a pending row appears and "Invitation sent to {email}." shows; no link is displayed', async () => {
    const bodies: unknown[] = [];
    let created = false;
    server.use(
      http.get(invites, () => HttpResponse.json({ items: created ? [invite(INVITE_1, 'new@example.com', 'pending')] : [], nextCursor: null })),
      http.post(invites, async ({ request }) => ((created = true), bodies.push(await request.json()), HttpResponse.json(invite(INVITE_1, 'new@example.com', 'pending'), { status: 201 }))),
    );
    const user = userEvent.setup();
    const { container } = show();
    const role = await screen.findByLabelText('Role');
    expect(within(role).getAllByRole('option').map((option) => option.textContent)).toEqual(['Admin', 'Staff', 'Viewer']);
    await user.type(screen.getByLabelText('E-mail address'), 'new@example.com');
    await user.selectOptions(role, 'VIEWER');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Invitation sent to new@example.com.')).toBeInTheDocument();
    expect(bodies).toEqual([{ email: 'new@example.com', role: 'VIEWER' }]);
    expect(await screen.findByRole('rowheader', { name: 'new@example.com' })).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/\/invites\/[A-Za-z0-9_-]{8,}/);
  });

  it.each([
    ['seat_limit_reached', 'Your plan has no free seats.'],
    ['invite_pending', 'An invitation is already pending for this address.'],
    ['already_member', 'This person is already a member.'],
  ] as [SellerProblemCode, string][])('W04 AS-77: %s reads "%s"', async (code, text) => {
    server.use(listInvites([]), http.post(invites, () => sellerProblem(code)));
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByLabelText('E-mail address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText(/Invitation sent/)).not.toBeInTheDocument();
  });

  it('W04 AS-77: a 429 shows the countdown and disables Send invitation until it ends', async () => {
    server.use(listInvites([]), http.post(invites, () => sellerProblem('rate_limited', { retryAfter: 30 })));
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByLabelText('E-mail address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Too many requests. Try again in 30 s.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send invitation' })).toBeDisabled());
  });

  it('W04 AS-77: a 400 puts the message at the e-mail field', async () => {
    server.use(listInvites([]), http.post(invites, () => sellerProblem('validation_failed', { errors: [{ field: 'email', code: 'invalid' }] })));
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByLabelText('E-mail address'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Check this field.')).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail address')).toHaveAttribute('aria-invalid', 'true');
  });

  it('W04 AS-78: Resend shows "Invitation resent"; Revoke asks first, then the row reads Revoked; settled rows have no actions', async () => {
    let revoked = false;
    server.use(
      http.get(invites, () =>
        HttpResponse.json({
          items: [invite(INVITE_1, 'one@example.com', revoked ? 'revoked' : 'pending'), invite(INVITE_2, 'two@example.com', 'accepted')],
          nextCursor: null,
        }),
      ),
      http.post(`${invites}/${INVITE_1}/resend`, () => HttpResponse.json(invite(INVITE_1, 'one@example.com', 'pending'))),
      http.delete(`${invites}/${INVITE_1}`, () => ((revoked = true), new HttpResponse(null, { status: 204 }))),
    );
    const user = userEvent.setup();
    show();
    await screen.findByText('one@example.com');
    expect(screen.queryByRole('button', { name: 'Actions for two@example.com' })).not.toBeInTheDocument();
    await chooseFromMenu(user, 'one@example.com', 'Resend');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Invitation resent'));
    await chooseFromMenu(user, 'one@example.com', 'Revoke');
    const dialog = await screen.findByRole('dialog', { name: 'Revoke invitation for one@example.com' });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(within(rowOf('one@example.com')).getByText('Revoked')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Actions for one@example.com' })).not.toBeInTheDocument();
  });

  it('W04 AS-78: the status filter is in the URL (Pending by default) and is sent to the API', async () => {
    const statuses: (string | null)[] = [];
    server.use(http.get(invites, ({ request }) => (statuses.push(new URL(request.url).searchParams.get('status')), HttpResponse.json({ items: [], nextCursor: null }))));
    const user = userEvent.setup();
    show();
    const select = await screen.findByLabelText('Status');
    expect(select).toHaveValue('pending');
    await user.selectOptions(select, 'expired');
    expect(push).toHaveBeenCalledWith(`${PATH}?tab=invitations&status=expired`);
    expect(statuses).toContain('pending');
  });

  it('W04 AS-78: invitations are a {items, nextCursor} page with Next page', async () => {
    server.use(listInvites([invite(INVITE_1, 'one@example.com', 'pending')], 'i2'));
    show();
    expect(await screen.findByRole('link', { name: 'Next page' })).toHaveAttribute('href', `${PATH}?tab=invitations&cursor=i2`);
  });

  it('W04 AS-74: without members.manage the Invitations tab is not offered and no invitation is requested', async () => {
    search = '';
    show(shopFixture({ myRole: 'STAFF', myPermissions: ['shop.read', 'members.read'] }));
    await screen.findByRole('table', { name: /members/i });
    expect(screen.queryByRole('tab', { name: 'Invitations' })).not.toBeInTheDocument();
  });
});

describe('W04 roles matrix', () => {
  const roles = {
    roles: {
      OWNER: ['shop.read', 'members.manage', 'products.write'],
      ADMIN: ['shop.read', 'members.manage'],
      STAFF: ['shop.read', 'products.write'],
      VIEWER: ['shop.read'],
    },
    permissions: ['shop.read', 'members.manage', 'products.write', 'future.thing'],
  };

  it('W04 AS-79: roles are columns, permissions are rows, each cell says Allowed or Not allowed in text, the own role is marked', async () => {
    search = 'tab=roles';
    server.use(http.get(`${origin}/api/shop-roles`, () => HttpResponse.json(roles)));
    show();
    const table = await screen.findByRole('table', { name: /roles/i });
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Permission', 'Admin', 'Staff', 'Viewer']));
    expect(headers.some((text) => /Owner.*your role/i.test(text ?? ''))).toBe(true);
    const row = within(table).getByText('Manage team members').closest('tr') as HTMLElement;
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toEqual(['Allowed', 'Allowed', 'Not allowed', 'Not allowed']);
    expect(within(table).getByText('future.thing')).toBeInTheDocument();
    expect(within(table).queryByText('shop.read')).not.toBeInTheDocument();
  });
});

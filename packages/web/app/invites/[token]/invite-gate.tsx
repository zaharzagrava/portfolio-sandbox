import { requireServerSession } from '@/lib/auth/session.server';
import { acceptInviteAction } from './actions';
import { AcceptInvite } from './accept-invite';

/**
 * The server half of `/invites/{token}` (W04 AS-80, AS-82): a signed-out visitor goes to sign-in with
 * `returnTo=/invites/{token}`; a signed-in one gets the accept button. The token is read here, on the server, and reaches the
 * browser only as the bound argument of the action (encrypted by Next), never as a prop, a query key or a page name.
 */
export async function InviteGate({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await requireServerSession(`/invites/${encodeURIComponent(token)}`);
  return <AcceptInvite accept={acceptInviteAction.bind(null, token)} />;
}

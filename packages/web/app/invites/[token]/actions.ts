'use server';

import { postAcceptInvite, type AcceptInviteResult } from '@/lib/server/invite.server';

/**
 * Accept an invitation (W04 AS-80, AS-82). The page binds the token to this function on the server, so the browser only
 * holds an opaque reference to it. A Server Function is reachable by anyone with its address: the session is checked again
 * in `postAcceptInvite`, which refuses without the session and CSRF cookies. It never throws to the browser.
 */
export async function acceptInviteAction(token: string): Promise<AcceptInviteResult> {
  try {
    return await postAcceptInvite(token);
  } catch {
    return { ok: false, code: 'service_unavailable' };
  }
}

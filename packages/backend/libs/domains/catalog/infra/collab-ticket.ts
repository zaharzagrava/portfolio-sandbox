import * as jwt from 'jsonwebtoken';

const TYPE = 'collab-ticket';
const TTL_SEC = 60;

export interface CollabTicket {
  userId: string;
  draftId: string;
  canWrite: boolean;
}

/**
 * Browsers can't set headers on a WebSocket, and access tokens in URLs end up
 * in logs. So: an authenticated HTTP call mints a 60-second ticket bound to ONE
 * draft and ONE permission level; the WS handshake carries only that.
 */
export function signCollabTicket(ticket: CollabTicket, secret: string): string {
  return jwt.sign(
    { sub: ticket.userId, d: ticket.draftId, w: ticket.canWrite, typ: TYPE },
    secret,
    { expiresIn: TTL_SEC },
  );
}

export function verifyCollabTicket(
  token: string,
  secret: string,
): CollabTicket | null {
  try {
    const claims = jwt.verify(token, secret) as {
      sub: string;
      d: string;
      w: boolean;
      typ: string;
    };
    return claims.typ === TYPE
      ? { userId: claims.sub, draftId: claims.d, canWrite: !!claims.w }
      : null;
  } catch {
    return null;
  }
}

export type SessionRole = 'USER' | 'SELLER' | 'MODERATOR' | 'ADMIN';

/** The encrypted record behind `bff:sess:{sha256(cookie)}` (data-model.md). "Ended" is "record absent". */
export interface SessionRecord {
  v: 1;
  /** S01 session id: used to revoke the identity session. */
  sessionId: string;
  user: { id: string; email: string | null; role: SessionRole };
  /** Never leaves the server. */
  accessToken: string;
  accessExp: number;
  refreshToken: string;
  /** +1 per successful refresh; guards the compare-and-set write. */
  tokenVersion: number;
  createdAt: number;
  lastSeenAt: number;
  idleExp: number;
  absoluteExp: number;
}

/** Pending second-factor login: `bff:mfa:{sha256(mfaCookie)}`. The challenge token never reaches the browser. */
export interface PendingMfa {
  mfaToken: string;
  createdAt: number;
  clientIp: string;
}

import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  KEY_STORE,
  SESSION_REPOSITORY,
  USER_REPOSITORY,
  type KeyStorePort,
  type SessionMeta,
  type SessionRepository,
  type UserRecord,
  type UserRepository,
} from '../domain/ports';
import { Domain_InvalidTokenError } from '../domain/errors';
import { epochSec, MAX_ACTIVE_SESSIONS } from '../domain/session-policy';
import { AccessTokenSigner } from './access-token-signer.service';
import { AuditService } from './audit.service';
import { SessionRevocationService } from './session-revocation.service';
import { TokenAuthService } from './token-auth.service';

export const MFA_CHALLENGE_TYP = 'mfa+jwt';
export const MFA_CHALLENGE_AUDIENCE = 'mfa';
const MFA_CHALLENGE_TTL_SEC = 300;

/** How the user already proved who they are when the second factor is asked for (`amr` of the final session). */
export type FirstFactor = 'pwd' | 'fed';

export interface IssuedSession {
  accessToken: { token: string; expiresIn: number };
  refreshToken: string;
  sessionId: string;
  user: { id: string; email: string | null; role: UserRecord['role'] };
  delivery: 'body' | 'cookie';
}

/**
 * The one place that creates a session and signs its tokens (login, second factor and OIDC all end here). Tokens are
 * signed before the session is stored: a signing failure leaves no session behind, and a storage failure leaves only
 * a token that names a session that does not exist (FR-039).
 */
@Injectable()
export class SessionIssuer {
  constructor(
    @Inject(KEY_STORE) private readonly keys: KeyStorePort,
    private readonly signer: AccessTokenSigner,
    private readonly tokens: TokenAuthService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly revocation: SessionRevocationService,
    private readonly audit: AuditService,
  ) {}

  async issue(input: {
    userId: string;
    amr: string[];
    delivery?: 'body' | 'cookie';
    meta?: SessionMeta;
  }): Promise<IssuedSession> {
    const user = await this.users.findById(input.userId);
    if (!user) throw new Domain_InvalidTokenError('unknown_user');
    const sid = uuidv7();
    const accessToken = await this.accessToken(user, sid, input.amr);
    const { refreshToken } = await this.sessions.create({
      sid,
      userId: user.id,
      amr: input.amr,
      meta: input.meta ?? {},
      now: this.clock.now(),
    });
    await this.evictOverflow(user.id);
    this.audit.record('auth.session.created', {
      userId: user.id,
      sessionId: sid,
    });
    return {
      accessToken,
      refreshToken,
      sessionId: sid,
      user: { id: user.id, email: user.email, role: user.role },
      delivery: input.delivery ?? 'body',
    };
  }

  /** At most `MAX_ACTIVE_SESSIONS` stay active per user; the oldest ones are revoked (FR-036). */
  private async evictOverflow(userId: string): Promise<void> {
    const now = epochSec(this.clock.now());
    const active = (await this.sessions.listForUser(userId)).filter(
      (s) => !s.revokedAt && s.absoluteExpiry > now,
    ); // newest first
    for (const old of active.slice(MAX_ACTIVE_SESSIONS))
      await this.revocation.revokeBySid(old.sid, 'session_limit');
  }

  /** An access token for an existing session (refresh): role and everything else come from the user as of now. */
  accessToken(user: UserRecord, sid: string, amr: string[]) {
    return this.signer.sign({
      userId: user.id,
      role: user.role,
      sessionId: sid,
      amr,
    });
  }

  /** Second-factor challenge: purpose-limited, never accepted as an access token (FR-015, FR-027). */
  async createChallenge(input: {
    userId: string;
    firstFactor: FirstFactor;
  }): Promise<{ token: string; jti: string }> {
    const jti = uuidv7();
    const token = await this.keys.sign(
      { sub: input.userId, fa: input.firstFactor },
      {
        expiresInSec: MFA_CHALLENGE_TTL_SEC,
        audience: MFA_CHALLENGE_AUDIENCE,
        typ: MFA_CHALLENGE_TYP,
        jwtId: jti,
      },
    );
    return { token, jti };
  }

  /** Throws `Domain_InvalidTokenError` for any defect; the caller maps every one to the same challenge error. */
  async verifyChallenge(token: string): Promise<{
    userId: string;
    firstFactor: FirstFactor;
    jti: string;
    expiresAt: Date;
  }> {
    const claims = await this.tokens.verifyPurpose(token, {
      typ: MFA_CHALLENGE_TYP,
      aud: MFA_CHALLENGE_AUDIENCE,
    });
    const firstFactor = claims.fa;
    if (
      (firstFactor !== 'pwd' && firstFactor !== 'fed') ||
      typeof claims.jti !== 'string'
    )
      throw new Domain_InvalidTokenError('challenge_claims');
    return {
      userId: claims.sub,
      firstFactor,
      jti: claims.jti,
      expiresAt: new Date(claims.exp * 1000),
    };
  }
}

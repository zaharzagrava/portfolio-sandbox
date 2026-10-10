import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  SESSION_REPOSITORY,
  USER_REPOSITORY,
  type SessionMeta,
  type SessionRepository,
  type UserRecord,
  type UserRepository,
} from '../domain/ports';
import { Domain_InvalidTokenError } from '../domain/errors';
import { KeyStore } from '../infra/keys/key-store.service';
import { AccessTokenSigner } from './access-token-signer.service';
import { TokenAuthService } from './token-auth.service';

export const MFA_CHALLENGE_TYP = 'mfa+jwt';
export const MFA_CHALLENGE_AUDIENCE = 'mfa';
const MFA_CHALLENGE_TTL_SEC = 300;

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
    private readonly keys: KeyStore,
    private readonly signer: AccessTokenSigner,
    private readonly tokens: TokenAuthService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
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
    return {
      accessToken,
      refreshToken,
      sessionId: sid,
      user: { id: user.id, email: user.email, role: user.role },
      delivery: input.delivery ?? 'body',
    };
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
  createChallenge(userId: string): Promise<string> {
    return this.keys.sign(
      { sub: userId },
      {
        expiresInSec: MFA_CHALLENGE_TTL_SEC,
        audience: MFA_CHALLENGE_AUDIENCE,
        typ: MFA_CHALLENGE_TYP,
        jwtId: uuidv7(),
      },
    );
  }

  async verifyChallenge(token: string): Promise<{ userId: string }> {
    const claims = await this.tokens.verifyPurpose(token, {
      typ: MFA_CHALLENGE_TYP,
      aud: MFA_CHALLENGE_AUDIENCE,
    });
    return { userId: claims.sub };
  }
}

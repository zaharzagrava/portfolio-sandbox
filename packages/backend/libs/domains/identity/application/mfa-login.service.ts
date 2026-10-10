import { Inject, Injectable } from '@nestjs/common';
import {
  USER_REPOSITORY,
  type SessionMeta,
  type UserRepository,
} from '../domain/ports';
import { Domain_InvalidMfaChallengeError } from '../domain/errors';
import { SecondFactorService } from './second-factor.service';
import { IssuedSession, SessionIssuer } from './session-issuer.service';

/**
 * Completes a login that stopped at the second factor: verifies the challenge, checks the code, and only then asks
 * `SessionIssuer` for the session (after the commit of the spent step and challenge; the session write is network I/O).
 * Every defect of the challenge is the same `invalid_mfa_challenge`.
 */
@Injectable()
export class MfaLoginService {
  constructor(
    private readonly issuer: SessionIssuer,
    private readonly factor: SecondFactorService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  async verify(input: {
    mfaToken: string | undefined;
    code: string;
    delivery: 'body' | 'cookie';
    meta: SessionMeta;
  }): Promise<IssuedSession> {
    if (!input.mfaToken) throw new Domain_InvalidMfaChallengeError();
    const challenge = await this.issuer
      .verifyChallenge(input.mfaToken)
      .catch(() => {
        throw new Domain_InvalidMfaChallengeError();
      });
    if (!(await this.users.findById(challenge.userId)))
      throw new Domain_InvalidMfaChallengeError();

    const method = await this.factor.verifyForLogin({
      userId: challenge.userId,
      jti: challenge.jti,
      challengeExpiresAt: challenge.expiresAt,
      code: input.code,
    });
    return this.issuer.issue({
      userId: challenge.userId,
      amr: [challenge.firstFactor, method, 'mfa'],
      delivery: input.delivery,
      meta: input.meta,
    });
  }
}

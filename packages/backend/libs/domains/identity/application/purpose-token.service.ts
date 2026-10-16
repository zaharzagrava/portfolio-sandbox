import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { KEY_STORE, type KeyStorePort } from '../domain/ports';
import { TokenAuthService } from './token-auth.service';

/** `typ` of every purpose token: never `at+jwt`, so a purpose token is refused as an access token and vice versa (S01 FR-027). */
export const PURPOSE_TOKEN_TYP = 'purpose+jwt';

/** One answer for every way a purpose token can be wrong (signature, algorithm, issuer, audience, subject, expiry, type). */
export class InvalidPurposeTokenError extends Error {
  constructor(readonly reason: string = 'invalid') {
    super('invalid purpose token');
    this.name = 'InvalidPurposeTokenError';
  }
}

export interface PurposeTokenClaims {
  subject: string;
  jti: string | null;
  expiresAt: Date;
  claims: Record<string, unknown>;
}

/**
 * Short-lived, audience-scoped tokens for one purpose (S22 admission tokens first): ES256 from the JWKS key set,
 * `iss: marketplace`, `typ: purpose+jwt`. Verification uses the same pinned-algorithm checks as every other token
 * (`verifyPurposeToken`) and then compares the subject.
 */
@Injectable()
export class PurposeTokenService {
  constructor(
    @Inject(KEY_STORE) private readonly keys: KeyStorePort,
    private readonly tokens: TokenAuthService,
  ) {}

  sign(input: {
    subject: string;
    audience: string;
    ttlSec: number;
    jti?: string;
    claims?: Record<string, string | number>;
  }): Promise<string> {
    return this.keys.sign(
      { ...(input.claims ?? {}), sub: input.subject },
      {
        audience: input.audience,
        typ: PURPOSE_TOKEN_TYP,
        expiresInSec: input.ttlSec,
        jwtId: input.jti ?? uuidv7(),
      },
    );
  }

  async verify(
    token: string,
    expected: { audience: string; subject?: string },
  ): Promise<PurposeTokenClaims> {
    let claims;
    try {
      claims = await this.tokens.verifyPurpose(token, {
        typ: PURPOSE_TOKEN_TYP,
        aud: expected.audience,
      });
    } catch (error) {
      throw new InvalidPurposeTokenError(
        (error as { reason?: string }).reason ?? 'invalid',
      );
    }
    if (expected.subject !== undefined && claims.sub !== expected.subject)
      throw new InvalidPurposeTokenError('sub');
    const { iss, aud, sub, exp, iat, nbf, jti, ...rest } = claims;
    void iss;
    void aud;
    void iat;
    void nbf;
    return {
      subject: sub,
      jti: typeof jti === 'string' ? jti : null,
      expiresAt: new Date(exp * 1000),
      claims: rest,
    };
  }
}

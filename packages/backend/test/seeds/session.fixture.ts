import type { INestApplication } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AccessTokenSigner, SessionIssuer } from '@app/domains/identity';

export interface TestSession {
  accessToken: string;
  sessionId: string;
  /** `Bearer <accessToken>` */
  bearer: string;
  /** Present when the app hosts the identity API and a real session was stored. */
  refreshToken?: string;
}

/**
 * A "logged in" seeded user for specs of other capabilities (replaces the removed `AuthService.issueTokensFor`).
 * Where the app hosts the identity API module the session is created through `SessionIssuer`, exactly as a login
 * would (session record, refresh token); elsewhere only the access token is signed by the production signer
 * (`at+jwt`, ES256, 300 s) with a fresh session id and no stored session. Specs that exercise sessions themselves
 * use `createAuthApp` in the identity domain.
 */
export async function issueSession(
  app: INestApplication,
  user: { id: string; role: string },
  options: { sessionId?: string; amr?: string[] } = {},
): Promise<TestSession> {
  let issuer: SessionIssuer | undefined;
  try {
    issuer = app.get(SessionIssuer, { strict: false });
  } catch {
    issuer = undefined; // an app without the identity API module
  }
  if (issuer && !options.sessionId) {
    const issued = await issuer.issue({
      userId: user.id,
      amr: options.amr ?? ['pwd'],
    });
    return {
      accessToken: issued.accessToken.token,
      sessionId: issued.sessionId,
      bearer: `Bearer ${issued.accessToken.token}`,
      refreshToken: issued.refreshToken,
    };
  }
  const sessionId = options.sessionId ?? uuidv7();
  const { token } = await app.get(AccessTokenSigner).sign({
    userId: user.id,
    role: user.role as never,
    sessionId,
    amr: options.amr ?? ['pwd'],
  });
  return { accessToken: token, sessionId, bearer: `Bearer ${token}` };
}

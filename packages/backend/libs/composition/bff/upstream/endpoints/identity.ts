import { z } from 'zod';
import {
  authSessionSchema,
  mfaChallengeSchema,
  type AuthSession,
} from '@marketplace-sandbox/contracts';
import { Endpoint } from './endpoint';

/** S01 `POST /api/auth/login` (body delivery, never the `delivery` field): a session or a second-factor challenge. */
export const loginResultSchema = z.union([
  authSessionSchema,
  mfaChallengeSchema,
]);
export type LoginResult = z.infer<typeof loginResultSchema>;

/** Identity calls carry the real client address (last hop) so S01's per-address limits apply to the shopper. */
const identity = <T>(
  name: string,
  path: string,
  schema: z.ZodType<T>,
  forwardedFor: string,
  body: unknown,
  needsToken = false,
): Endpoint<T> => ({
  name,
  upstream: 'identity',
  method: 'POST',
  path,
  body,
  schema,
  identity: needsToken ? 'required' : 'none',
  sharedCache: false,
  breaker: false,
  headers: {
    'x-forwarded-for': forwardedFor,
    'content-type': 'application/json',
  },
});

export const loginCall = (
  credentials: { email: string; password: string },
  forwardedFor: string,
): Endpoint<LoginResult> =>
  identity(
    'login',
    '/api/auth/login',
    loginResultSchema,
    forwardedFor,
    credentials,
  );

/** S02 `POST /api/auth/mfa/verify`: the S01 login body on success. */
export const mfaVerifyCall = (
  input: { mfaToken: string; code: string },
  forwardedFor: string,
): Endpoint<AuthSession> =>
  identity(
    'mfa_verify',
    '/api/auth/mfa/verify',
    authSessionSchema,
    forwardedFor,
    input,
  );

/** S01 `POST /api/auth/refresh {refreshToken}`: strict reuse detection, so never retried and never replayed. */
export const refreshCall = (
  refreshToken: string,
  forwardedFor: string,
): Endpoint<AuthSession> =>
  identity('refresh', '/api/auth/refresh', authSessionSchema, forwardedFor, {
    refreshToken,
  });

/** S01 `POST /api/auth/logout` (Bearer, `204`, idempotent). */
export const logoutCall = (forwardedFor: string): Endpoint<unknown> =>
  identity(
    'logout',
    '/api/auth/logout',
    z.unknown(),
    forwardedFor,
    undefined,
    true,
  );

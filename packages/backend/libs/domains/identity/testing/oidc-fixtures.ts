import { createHash } from 'node:crypto';
import type { Response } from 'supertest';
import {
  FakeOidcProvider,
  type FakeClaims,
} from '../../../../test/fakes/fake-oidc-provider';
import { OIDC_NET_OPTIONS, OIDC_PROVIDER } from '../domain/ports';
import { OpenidClientProvider } from '../infra/oidc/openid-client.provider';
import { createAuthApp, type AuthTestApp } from './auth-app';

export const FRONT = 'http://localhost:3000';
export const REDIRECT_BASE = 'http://localhost:8400';
export const CALLBACK_URL = `${REDIRECT_BASE}/api/auth/oidc/google/callback`;
export const sha256Hex = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const ENV_KEYS = [
  'GOOGLE_OIDC_CLIENT_ID',
  'GOOGLE_OIDC_CLIENT_SECRET',
  'GOOGLE_OIDC_ISSUER',
  'AUTH_REDIRECT_BASE_URL',
] as const;

export interface OidcTestApp {
  t: AuthTestApp;
  provider: FakeOidcProvider;
  close(): Promise<void>;
  /** Forget the provider's recorded traffic, its faults and the app's cached discovery. */
  reset(): void;
  /** Drop only the app's cached discovery and key set. */
  forgetDiscovery(): void;
}

/** The real auth app with Google pointed at an in-process fake provider (hatches for a plain-http loopback host). */
export async function createOidcApp(
  options: { timeoutMs?: number; configured?: boolean } = {},
): Promise<OidcTestApp> {
  const provider = await FakeOidcProvider.start();
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  if (options.configured === false)
    for (const k of ENV_KEYS) delete process.env[k];
  else {
    process.env.GOOGLE_OIDC_CLIENT_ID = provider.clientId;
    process.env.GOOGLE_OIDC_CLIENT_SECRET = provider.clientSecret;
    process.env.GOOGLE_OIDC_ISSUER = provider.issuer;
    process.env.AUTH_REDIRECT_BASE_URL = REDIRECT_BASE;
  }
  const t = await createAuthApp({
    manualRateTime: true,
    overrides: [
      {
        provide: OIDC_NET_OPTIONS,
        useValue: {
          allowHttpHosts: [provider.host],
          allowPrivateHosts: [provider.host],
          ...(options.timeoutMs && { timeoutMs: options.timeoutMs }),
        },
      },
    ],
  });
  for (const [k, v] of saved)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  const forgetDiscovery = () =>
    t.app
      .get<OpenidClientProvider>(OIDC_PROVIDER, { strict: false })
      .invalidate('google');
  return {
    t,
    provider,
    forgetDiscovery,
    reset() {
      provider.reset();
      forgetDiscovery();
    },
    async close() {
      await t.close();
      await provider.stop();
    },
  };
}

/** Set-Cookie lines of a response keyed by cookie name. */
export function setCookies(
  res: Pick<Response, 'headers'>,
): Record<string, string> {
  const lines = (res.headers['set-cookie'] ?? []) as unknown as string[];
  return Object.fromEntries(lines.map((l) => [l.split('=')[0], l]));
}

/** The value of a cookie from its Set-Cookie line. */
export const cookieValue = (line: string): string =>
  line.split(';')[0].slice(line.indexOf('=') + 1);

export async function startFlow(
  app: OidcTestApp,
  options: {
    provider?: string;
    returnTo?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{
  res: Response;
  authorizationUrl: string;
  flowCookie: string | undefined;
}> {
  const res = await app.t
    .http()
    .post(`/api/auth/oidc/${options.provider ?? 'google'}/start`)
    .set(options.headers ?? {})
    .send(options.returnTo === undefined ? {} : { returnTo: options.returnTo });
  const flow = setCookies(res)['__Host-oidc-flow'];
  return {
    res,
    authorizationUrl: res.body.authorizationUrl as string,
    flowCookie: flow ? cookieValue(flow) : undefined,
  };
}

/** The browser returning from the provider: GET the callback with the flow cookie. */
export function callback(
  app: OidcTestApp,
  callbackUrl: string,
  flowCookie: string | undefined,
  provider = 'google',
) {
  const url = new URL(callbackUrl);
  return app.t
    .http()
    .get(`/api/auth/oidc/${provider}/callback${url.search}`)
    .set(flowCookie ? { Cookie: `__Host-oidc-flow=${flowCookie}` } : {});
}

/** A whole sign-in: start, approve at the provider with `claims`, come back. */
export async function signIn(
  app: OidcTestApp,
  claims: FakeClaims,
  options: { returnTo?: string } = {},
): Promise<{
  res: Response;
  back: string;
  authorizationUrl: string;
  flowCookie: string | undefined;
}> {
  const flow = await startFlow(app, options);
  const back = app.provider.approve(flow.authorizationUrl, claims);
  const res = await callback(app, back, flow.flowCookie);
  return { ...flow, res: res as Response, back };
}

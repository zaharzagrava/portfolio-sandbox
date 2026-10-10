import { randomUUID } from 'node:crypto';
import { BFF_COOKIES } from '@marketplace-sandbox/contracts';
import { ALLOWED_ORIGIN, BffTestApp } from './app-factory';
import {
  identitySessionFixture,
  productFixture,
  ProductFixture,
} from './fixtures';
import { StubUpstream } from './stub-upstream';

/** Polls until `check` is true; for effects that happen on the stub side after the BFF answered (aborts). */
export async function waitFor(
  check: () => boolean,
  timeoutMs = 2_000,
  what = 'condition',
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Registers a visible product (and its shop) on the stub and returns it. */
export function seedProduct(
  stub: StubUpstream,
  over: Parameters<typeof productFixture>[0] = {},
): ProductFixture {
  const product = productFixture(over);
  stub.products.set(product.id, product);
  return product;
}

/** `name=value` pairs of a response's `Set-Cookie` headers. */
export function cookiesOf(res: {
  headers: Record<string, unknown>;
}): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === 'string'
      ? [raw]
      : [];
  const out: Record<string, string> = {};
  for (const line of list) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

export interface SignedIn {
  /** Value for a `Cookie` request header. */
  cookie: string;
  csrf: string;
  sessionCookie: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
}

/** Logs in through the BFF against the stubbed identity service (S01). */
export async function signIn(
  app: BffTestApp,
  stub: StubUpstream,
  over: Parameters<typeof identitySessionFixture>[0] = {},
): Promise<SignedIn> {
  const body = identitySessionFixture({ userId: randomUUID(), ...over });
  stub.respondInOrder('login', [{ body }]);
  const res = await app
    .http()
    .post('/api/bff/session')
    .set('Origin', ALLOWED_ORIGIN)
    .send({
      email: body.user.email ?? 'shopper@example.com',
      password: 'correct horse',
    });
  if (res.status !== 200)
    throw new Error(
      `sign-in failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  const cookies = cookiesOf(res);
  const sessionCookie = cookies[BFF_COOKIES.session];
  const csrf = cookies[BFF_COOKIES.csrf];
  return {
    cookie: `${BFF_COOKIES.session}=${sessionCookie}; ${BFF_COOKIES.csrf}=${csrf}`,
    csrf,
    sessionCookie,
    accessToken: body.accessToken.token,
    refreshToken: body.refreshToken,
    userId: body.user.id,
  };
}

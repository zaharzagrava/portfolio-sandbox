import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { waitFor } from '../../utils/async-helpers';
import { resetRateLimits } from './rate-limits';

export const API_URL = process.env.API_URL ?? 'http://localhost:8000';

export const JOURNEY_PASSWORD = 'SuperSecurePassword123!';

export interface Reply<T = unknown> {
  status: number;
  /** The body parsed with the contract schema when one was given and the status was 2xx; the raw JSON otherwise. */
  body: T;
  headers: Headers;
}

export interface CallOptions<T> {
  body?: unknown;
  /** `Idempotency-Key` header. */
  key?: string;
  headers?: Record<string, string>;
  /** Contract schema from `packages/contracts`: a 2xx body that does not parse fails the test (VII.6). */
  schema?: ZodType<T>;
  query?: Record<string, string | number | undefined>;
  /** Internal: a call that already signed in again after a `401` (or is the sign-in itself) never signs in a second time. */
  signedInAgain?: boolean;
}

/** Access tokens live 5 minutes; a client signs in again after 4. */
const TOKEN_MAX_AGE_MS = 4 * 60_000;

/** Bumped whenever the journey moves the stack's clock: every token issued before may be expired or not yet valid. */
let clockEpoch = 0;
export const clockMoved = (): void => {
  clockEpoch += 1;
};

const SHED_RETRY_DEADLINE_MS = 60_000;

/**
 * Load shedding answers `503 service_overloaded` before any work is done (the gate sits before the body parsers), so a retry
 * is safe for every method; a loaded machine sheds the first burst of a run (L-007). Only that code is retried, with the
 * `Retry-After` the API gave, until a deadline; any other answer is returned as it is.
 */
async function fetchRetryingShed(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let last: Response | undefined;
  await waitFor(
    async () => {
      const response = await fetch(url, init);
      last = response;
      if (response.status !== 503) return true;
      const problem = (await response
        .clone()
        .json()
        .catch(() => null)) as { code?: string } | null;
      return problem?.code !== 'service_overloaded';
    },
    {
      timeoutMs: SHED_RETRY_DEADLINE_MS,
      intervalMs: 1_000,
      description: `${init.method} ${url} not shed`,
    },
  ).catch(() => undefined); // still shed at the deadline: the caller sees the 503 and fails with it
  return last as Response;
}

/** The unique, collision-free suffix every journey uses for its own data (L-005, L-006). */
export const unique = (prefix: string) =>
  `${prefix}-${randomUUID().slice(0, 8)}`;

/**
 * One actor of a journey: its own account, its own bearer token. Every response with a 2xx status is parsed with the
 * contract schema the caller passes, so a drift between the API and `packages/contracts` fails the journey here.
 * (Bearer rather than a cookie jar: the API accepts both and the cookie mode needs an allowed Origin and a CSRF round trip
 * that no hand-off of this journey depends on.)
 */
export class JourneyClient {
  token: string | null = null;
  userId: string | null = null;

  constructor(
    readonly email: string,
    readonly label = email,
  ) {}

  /** Registers (202, same answer for every address) then signs in; the account is brand new, so no shared state. */
  static async signUp(label: string): Promise<JourneyClient> {
    await resetRateLimits();
    const client = new JourneyClient(`${unique(label)}@example.com`, label);
    const registered = await client.call('POST', '/api/auth/register', {
      body: { email: client.email, password: JOURNEY_PASSWORD },
    });
    if (registered.status !== 202)
      throw new Error(
        `register ${label}: ${registered.status} ${JSON.stringify(registered.body)}`,
      );
    await client.signIn(JOURNEY_PASSWORD);
    return client;
  }

  private password: string | null = null;
  private renewal: Promise<void> | null = null;
  private signedAt = 0;
  private epoch = 0;
  private sessionId: string | null = null;

  /**
   * One new sign-in for all the calls that found `stale` unusable at the same moment (the login is rate limited), after which
   * the session it replaces is revoked: a run moves the clock many times and an account may hold only 20 active sessions,
   * the newest by creation time winning (sessions dated in the future would evict every sign-in made after the clock went back).
   */
  private async renew(stale: string | null): Promise<void> {
    if (this.token === stale) {
      this.renewal ??= (async () => {
        const previous = this.sessionId;
        await this.signIn(this.password!);
        if (previous && previous !== this.sessionId)
          await this.call('DELETE', `/api/auth/sessions/${previous}`, {
            signedInAgain: true,
          }).catch(() => undefined);
      })().finally(() => (this.renewal = null));
    }
    if (this.renewal) await this.renewal; // a concurrent call is already signing in
  }

  async signIn(password: string): Promise<void> {
    this.password = password;
    const login = await this.call<{ accessToken: { token: string } }>(
      'POST',
      '/api/auth/login',
      {
        body: { email: this.email, password },
        signedInAgain: true,
      },
    );
    if (login.status !== 200)
      throw new Error(
        `login ${this.label}: ${login.status} ${JSON.stringify(login.body)}`,
      );
    this.token = login.body.accessToken.token;
    const payload = JSON.parse(
      Buffer.from(this.token.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string; sid?: string };
    this.userId = payload.sub;
    this.sessionId = payload.sid ?? null;
    this.signedAt = Date.now();
    this.epoch = clockEpoch;
  }

  async call<T = unknown>(
    method: string,
    path: string,
    options: CallOptions<T> = {},
  ): Promise<Reply<T>> {
    const query = options.query
      ? '?' +
        new URLSearchParams(
          Object.entries(options.query)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        ).toString()
      : '';
    // Renew before the call when the token cannot be good any more: some routes (the cart) treat an expired token as a guest
    // instead of answering 401, which would put the call into a cart nobody owns.
    if (
      this.password &&
      this.token &&
      !options.signedInAgain &&
      (this.epoch !== clockEpoch ||
        Date.now() - this.signedAt > TOKEN_MAX_AGE_MS)
    ) {
      await this.renew(this.token);
    }
    const used = this.token;
    const response = await fetchRetryingShed(`${API_URL}${path}${query}`, {
      method,
      headers: {
        ...(options.body !== undefined && {
          'content-type': 'application/json',
        }),
        ...(this.token && { authorization: `Bearer ${this.token}` }),
        ...(options.key && { 'idempotency-key': options.key }),
        ...options.headers,
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    // An access token lives five minutes of the stack's clock, which the journey may also have moved: sign in again once.
    if (
      response.status === 401 &&
      this.password &&
      this.token &&
      !options.signedInAgain
    ) {
      await this.renew(used);
      return this.call<T>(method, path, { ...options, signedInAgain: true });
    }
    const text = await response.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    const ok = response.status >= 200 && response.status < 300;
    const body =
      ok && options.schema ? options.schema.parse(json) : (json as T);
    return { status: response.status, body, headers: response.headers };
  }

  get<T = unknown>(path: string, options: CallOptions<T> = {}) {
    return this.call<T>('GET', path, options);
  }
  post<T = unknown>(path: string, options: CallOptions<T> = {}) {
    return this.call<T>('POST', path, options);
  }
  put<T = unknown>(path: string, options: CallOptions<T> = {}) {
    return this.call<T>('PUT', path, options);
  }
}

/** `code` of an `application/problem+json` body (V.3), or undefined. */
export const problemCode = (body: unknown): string | undefined =>
  body && typeof body === 'object'
    ? (body as { code?: string }).code
    : undefined;

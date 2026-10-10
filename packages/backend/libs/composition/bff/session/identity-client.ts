import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { AuthSession } from '@marketplace-sandbox/contracts';
import { AppError, ErrorArea } from '@app/common/errors';
import { RequestSlots } from '../upstream/concurrency-gate';
import {
  LoginResult,
  loginCall,
  logoutCall,
  mfaVerifyCall,
  refreshCall,
} from '../upstream/endpoints/identity';
import { UpstreamClient } from '../upstream/upstream-client';
import { BffProblem } from '../problem';
import { classify } from '../upstream/upstream-error';

/** Per-call budgets of the identity relays: login-class calls and the one refresh attempt (S48 FR-046: 2 s, no retry). */
const LOGIN_BUDGET_MS = 3_000;
const REFRESH_BUDGET_MS = 2_000;
const LOGOUT_BUDGET_MS = 2_000;

const GENERIC: Record<number, [string, string]> = {
  400: ['Bad Request', 'The request is not valid.'],
  401: ['Unauthorized', 'The credentials were not accepted.'],
  403: ['Forbidden', 'The request is not allowed.'],
  404: ['Not Found', 'The resource was not found.'],
  409: ['Conflict', 'The request conflicts with the current state.'],
  422: ['Unprocessable Entity', 'The request could not be processed.'],
  429: ['Too Many Requests', 'Too many requests. Retry later.'],
};

/**
 * An answer of the identity service relayed to the browser "unchanged in meaning" (S48 FR-042): its status and problem
 * `code`, with a generic detail of our own so nothing of the upstream text (an address, a name) reaches the client, and
 * identical bodies for identical codes (no account enumeration).
 */
export class RelayedProblem extends AppError {
  constructor(status: number, code: string, retryAfterSeconds?: number) {
    const [title, detail] = GENERIC[status] ?? GENERIC[400];
    super({
      code,
      status: status as HttpStatus,
      title,
      detail,
      area: ErrorArea.DOMAIN,
      retryAfterSeconds,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

/**
 * S01 / S02 relay (S48 plan: identity-client). Body delivery only: the BFF never sets `delivery: "cookie"`. Every call
 * is one attempt, no retry (a refresh token is spent by the first attempt that reaches S01).
 */
@Injectable()
export class IdentityClient {
  private readonly logger = new Logger(IdentityClient.name);

  constructor(private readonly upstream: UpstreamClient) {}

  private slots(): RequestSlots {
    return this.upstream.gate.forRequest();
  }

  async login(
    credentials: { email: string; password: string },
    clientIp: string,
  ): Promise<LoginResult> {
    return (
      await this.upstream.call(loginCall(credentials, clientIp), {
        credentials: { kind: 'anonymous' },
        slots: this.slots(),
        budgetMs: LOGIN_BUDGET_MS,
      })
    ).body;
  }

  async verifyMfa(
    input: { mfaToken: string; code: string },
    clientIp: string,
  ): Promise<AuthSession> {
    return (
      await this.upstream.call(mfaVerifyCall(input, clientIp), {
        credentials: { kind: 'anonymous' },
        slots: this.slots(),
        budgetMs: LOGIN_BUDGET_MS,
      })
    ).body;
  }

  async refresh(refreshToken: string, clientIp: string): Promise<AuthSession> {
    return (
      await this.upstream.call(refreshCall(refreshToken, clientIp), {
        credentials: { kind: 'anonymous' },
        slots: this.slots(),
        budgetMs: REFRESH_BUDGET_MS,
      })
    ).body;
  }

  /** Best effort: a failure is logged without the token and never fails the caller. */
  async logout(accessToken: string, clientIp: string): Promise<boolean> {
    try {
      await this.upstream.call(logoutCall(clientIp), {
        credentials: { kind: 'bearer', token: accessToken },
        slots: this.slots(),
        budgetMs: LOGOUT_BUDGET_MS,
      });
      return true;
    } catch (error) {
      this.logger.warn(`identity logout failed (${classify(error).code})`);
      return false;
    }
  }

  /** The browser-facing error for a failed relay. 4xx keeps its status and code; everything else is a 503. */
  problemFor(error: unknown): AppError {
    const failure = classify(error);
    const status = failure.status;
    if (
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      status !== 408
    ) {
      const code =
        failure.problemCode ??
        (
          {
            401: 'invalid_credentials',
            429: 'rate_limited',
            400: 'validation_failed',
          } as Record<number, string>
        )[status] ??
        'request_rejected';
      return new RelayedProblem(
        status,
        code,
        status === 429
          ? Math.max(1, Math.ceil((failure.retryAfterMs ?? 1_000) / 1_000))
          : undefined,
      );
    }
    if (failure.code === 'UPSTREAM_INVALID' && status === undefined)
      return new BffProblem('upstream_invalid');
    return new RelayedUnavailable(
      Math.max(1, Math.ceil((failure.retryAfterMs ?? 1_000) / 1_000)),
      failure.problemCode === 'overloaded'
        ? 'overloaded'
        : 'upstream_unavailable',
    );
  }
}

export class RelayedUnavailable extends AppError {
  constructor(
    retryAfterSeconds: number,
    code: 'overloaded' | 'upstream_unavailable',
  ) {
    super({
      code,
      status: HttpStatus.SERVICE_UNAVAILABLE,
      title: 'Service Unavailable',
      detail: 'The sign-in service is busy. Retry shortly.',
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

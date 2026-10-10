import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  BFF_COOKIES,
  type MfaRequiredResponse,
  type SessionLoginRequest,
  type SessionMfaRequest,
  type SessionResponse,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { BffSettings } from '../bff-config';
import { readCookie } from '../credentials/request-credentials';
import { BffProblem } from '../problem';
import { classify } from '../upstream/upstream-error';
import { csrfSessionId } from './csrf-origin.guard';
import { issueCsrfToken } from './csrf-token';
import { IdentityClient } from './identity-client';
import { sessionCookies } from './session-cookies';
import { SessionManager } from './session-manager';
import type { SessionRecord } from './session-record';
import { mfaLockKey, SessionStore } from './session-store';

const MFA_LOCK_MS = 10_000;

const clientIpOf = (req: Request): string =>
  (req as Request & { clientIp?: string }).clientIp ?? req.ip ?? '';

/**
 * Login, second factor, current session and logout (S48 FR-040..FR-049). The browser only ever receives opaque cookies:
 * tokens and the challenge stay in the store (encrypted). Every success issues a new session id and deletes the one
 * the browser held (fixation); identity answers are relayed in meaning by `IdentityClient.problemFor`.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly sessions: SessionManager,
    private readonly store: SessionStore,
    private readonly identity: IdentityClient,
    private readonly settings: BffSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private toResponse(record: SessionRecord): SessionResponse {
    return { user: record.user, expiresAt: this.sessions.expiresAt(record) };
  }

  async login(
    body: SessionLoginRequest,
    req: Request,
    res: Response,
  ): Promise<SessionResponse | MfaRequiredResponse> {
    const ip = clientIpOf(req);
    let result;
    try {
      result = await this.identity.login(body, ip);
    } catch (error) {
      throw this.identity.problemFor(error);
    }
    if ('mfaRequired' in result) {
      const cookie = randomBytes(32).toString('base64url');
      try {
        await this.store.createPending(
          cookie,
          {
            mfaToken: result.mfaToken,
            createdAt: this.clock.nowMs(),
            clientIp: ip,
          },
          this.settings.session.mfaPendingMs,
        );
      } catch {
        throw new BffProblem('session_unavailable', { retryAfterSeconds: 1 });
      }
      sessionCookies.setMfa(
        res,
        cookie,
        Math.floor(this.settings.session.mfaPendingMs / 1_000),
      );
      return { mfaRequired: true };
    }
    const created = await this.sessions.create(result, res);
    await this.replacePrevious(req, created.cookie, ip);
    return this.toResponse(created.record);
  }

  async verifyMfa(
    body: SessionMfaRequest,
    req: Request,
    res: Response,
  ): Promise<SessionResponse> {
    const ip = clientIpOf(req);
    const mfaCookie = readCookie(req, BFF_COOKIES.mfa);
    if (!mfaCookie) throw new BffProblem('mfa_not_pending');

    let pending;
    try {
      pending = await this.store.getPending(mfaCookie);
    } catch {
      throw new BffProblem('session_unavailable', { retryAfterSeconds: 1 });
    }
    if (
      !pending ||
      this.clock.nowMs() - pending.createdAt >=
        this.settings.session.mfaPendingMs
    )
      throw new BffProblem('mfa_not_pending');

    const lockKey = mfaLockKey(mfaCookie);
    const owner = await this.store
      .acquireLock(lockKey, MFA_LOCK_MS)
      .catch(() => {
        throw new BffProblem('session_unavailable', { retryAfterSeconds: 1 });
      });
    if (!owner) throw new BffProblem('mfa_not_pending'); // a concurrent verify holds it: of those, one wins
    try {
      // consumed by the winner while we waited for the lock?
      if (!(await this.store.getPending(mfaCookie)))
        throw new BffProblem('mfa_not_pending');
      let auth;
      try {
        auth = await this.identity.verifyMfa(
          { mfaToken: pending.mfaToken, code: body.code },
          ip,
        );
      } catch (error) {
        const failure = classify(error);
        if (
          failure.status === 401 &&
          failure.problemCode === 'invalid_mfa_challenge'
        ) {
          // the challenge is spent or expired: the pending state is over
          await this.store.deletePending(mfaCookie).catch(() => undefined);
          sessionCookies.clearMfa(res);
          throw new BffProblem('invalid_token');
        }
        throw this.identity.problemFor(error);
      }
      const created = await this.sessions.create(auth, res);
      await this.store.deletePending(mfaCookie).catch(() => undefined);
      sessionCookies.clearMfa(res);
      await this.replacePrevious(req, created.cookie, ip);
      return this.toResponse(created.record);
    } finally {
      await this.store.releaseLock(lockKey, owner).catch(() => undefined);
    }
  }

  /** Any session the browser still held is deleted at once; its identity session is revoked best effort. */
  private async replacePrevious(
    req: Request,
    newCookie: string,
    ip: string,
  ): Promise<void> {
    const previous = readCookie(req, BFF_COOKIES.session);
    if (!previous || previous === newCookie) return;
    const old = await this.store.get(previous).catch(() => undefined);
    await this.store.delete(previous).catch(() => undefined);
    if (old) await this.identity.logout(old.accessToken, ip);
  }

  async current(req: Request, res: Response): Promise<SessionResponse> {
    const cookie = readCookie(req, BFF_COOKIES.session);
    if (!cookie) throw new BffProblem('unauthenticated');
    const loaded = await this.sessions.load(cookie);
    if (loaded.state !== 'active') {
      sessionCookies.clearSession(res);
      throw new BffProblem(
        loaded.state === 'expired' ? 'session_expired' : 'unauthenticated',
      );
    }
    if (!readCookie(req, BFF_COOKIES.csrf))
      sessionCookies.setCsrf(
        res,
        issueCsrfToken(this.settings.csrfKey, csrfSessionId(cookie)),
        Math.max(
          0,
          Math.floor((loaded.record.absoluteExp - this.clock.nowMs()) / 1_000),
        ),
      );
    return this.toResponse(loaded.record);
  }

  /** Idempotent: the local record goes first, the identity call is best effort, the answer is always the same. */
  async logout(req: Request, res: Response): Promise<void> {
    const cookie = readCookie(req, BFF_COOKIES.session);
    sessionCookies.clearAll(res);
    if (!cookie) return;
    let record: SessionRecord | undefined;
    try {
      record = await this.store.get(cookie);
      await this.store.delete(cookie);
    } catch {
      throw new BffProblem('session_unavailable', { retryAfterSeconds: 1 });
    }
    if (record) await this.identity.logout(record.accessToken, clientIpOf(req));
  }
}

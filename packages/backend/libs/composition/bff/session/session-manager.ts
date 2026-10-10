import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { AuthSession } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { BffSettings } from '../bff-config';
import { BffProblem } from '../problem';
import { csrfSessionId } from './csrf-origin.guard';
import { issueCsrfToken } from './csrf-token';
import { sessionCookies } from './session-cookies';
import {
  expiryOf,
  initialDeadlines,
  shouldTouch,
  touchedIdleExp,
  ttlMs,
} from './session-lifetime';
import type { SessionRecord } from './session-record';
import { SessionStore } from './session-store';

export type LoadedSession =
  | { state: 'active'; record: SessionRecord }
  /** No such session: never existed, store key gone, forged or logged out. */
  | { state: 'unknown' }
  /** Past its idle or absolute deadline: the record was deleted just now. */
  | { state: 'expired' };

const TOUCH_INTERVAL_MS = 60_000;

/** Reads, creates, extends and ends sessions on top of the store. Store failures become `session_unavailable`. */
@Injectable()
export class SessionManager {
  private readonly logger = new Logger(SessionManager.name);

  constructor(
    private readonly store: SessionStore,
    private readonly settings: BffSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private unavailable(): BffProblem {
    return new BffProblem('session_unavailable', { retryAfterSeconds: 1 });
  }

  async load(cookie: string): Promise<LoadedSession> {
    let record: SessionRecord | undefined;
    try {
      record = await this.store.get(cookie);
    } catch {
      throw this.unavailable();
    }
    if (!record) return { state: 'unknown' };
    const now = this.clock.nowMs();
    if (expiryOf(record, now) !== 'active') {
      await this.store.delete(cookie).catch(() => undefined);
      return { state: 'expired' };
    }
    return { state: 'active', record: await this.touch(cookie, record, now) };
  }

  /** The idle extension is written at most once a minute and never past the absolute deadline. */
  private async touch(
    cookie: string,
    record: SessionRecord,
    now: number,
  ): Promise<SessionRecord> {
    if (!shouldTouch(record.lastSeenAt, now, TOUCH_INTERVAL_MS)) return record;
    const next: SessionRecord = {
      ...record,
      lastSeenAt: now,
      idleExp: touchedIdleExp(record, now, this.settings.session),
    };
    try {
      const result = await this.store.compareAndSet(
        cookie,
        record.tokenVersion,
        next,
        ttlMs(next, now),
      );
      return result === 'ok' ? next : record;
    } catch (error) {
      this.logger.warn(`session touch failed (${(error as Error).name})`);
      return record;
    }
  }

  /** A new session from an identity login result; the cookie value is fresh randomness, never client input. */
  async create(
    auth: AuthSession,
    res: Response,
  ): Promise<{ cookie: string; record: SessionRecord }> {
    const now = this.clock.nowMs();
    const deadlines = initialDeadlines(now, this.settings.session);
    const record: SessionRecord = {
      v: 1,
      sessionId: auth.sessionId,
      user: auth.user,
      accessToken: auth.accessToken.token,
      accessExp: now + auth.accessToken.expiresIn * 1_000,
      refreshToken: auth.refreshToken,
      tokenVersion: 1,
      createdAt: now,
      lastSeenAt: now,
      ...deadlines,
    };
    const cookie = randomBytes(32).toString('base64url');
    try {
      await this.store.create(cookie, record, ttlMs(record, now));
    } catch {
      throw this.unavailable();
    }
    const maxAge = Math.floor((record.absoluteExp - now) / 1_000);
    sessionCookies.setSession(
      res,
      cookie,
      issueCsrfToken(this.settings.csrfKey, csrfSessionId(cookie)),
      maxAge,
    );
    return { cookie, record };
  }

  /** When the session ends (`expiresAt` of the answers): whichever deadline comes first. */
  expiresAt(record: SessionRecord): string {
    return new Date(Math.min(record.idleExp, record.absoluteExp)).toISOString();
  }

  async end(cookie: string): Promise<void> {
    await this.store.delete(cookie);
  }
}

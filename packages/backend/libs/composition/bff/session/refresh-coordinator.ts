import { Inject, Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { AuthSession } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { BffSettings } from '../bff-config';
import { BffProblem } from '../problem';
import { classify } from '../upstream/upstream-error';
import { IdentityClient } from './identity-client';
import type { SessionRecord } from './session-record';
import { ttlMs } from './session-lifetime';
import { refreshLockKey, SessionStore } from './session-store';

/** The session cannot continue: the browser must sign in again. */
export class SessionEndedError extends Error {
  constructor(readonly reason: 'refresh_rejected' | 'store_lost' | 'gone') {
    super(`session ended (${reason})`);
  }
}

const LOCK_MS = 5_000;
const WRITE_ATTEMPTS = 3;

const refreshOutcomes = () =>
  MetricsRegistry.counter({
    name: 'bff_session_refresh_total',
    help: 'Token refresh attempts by outcome',
    labels: ['outcome'],
  });

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Single-flight refresh per session across BFF instances (S48 FR-046, research R-7). The holder of a short Redis lock
 * re-reads the record (another instance may just have finished), calls S01 once (2 s, no retry), and stores the rotated
 * tokens with a version-guarded write (up to three attempts) before anyone uses them; the others wait for the higher
 * `tokenVersion`. A refresh token is presented at most once: `401` ends the session, a transient failure keeps it, and
 * three failed writes end it rather than risk presenting a spent token again.
 */
@Injectable()
export class RefreshCoordinator {
  private readonly logger = new Logger(RefreshCoordinator.name);

  constructor(
    private readonly store: SessionStore,
    private readonly identity: IdentityClient,
    private readonly settings: BffSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private fresh(record: SessionRecord): boolean {
    return (
      record.accessExp - this.clock.nowMs() >
      this.settings.session.refreshSkewMs
    );
  }

  /**
   * The record to use for this request: the given one when its token has more than the skew left, otherwise the result
   * of the (single) refresh. Throws `SessionEndedError` or `BffProblem('session_unavailable')`.
   */
  async ensureFresh(
    cookie: string,
    record: SessionRecord,
    clientIp: string,
  ): Promise<SessionRecord> {
    if (this.fresh(record)) return record;
    const lockKey = refreshLockKey(cookie);
    const owner = await this.store.acquireLock(lockKey, LOCK_MS).catch(() => {
      throw this.unavailable();
    });
    if (!owner) return this.waitForRotation(cookie, record);
    try {
      const current = await this.store.get(cookie).catch(() => {
        throw this.unavailable();
      });
      if (!current) throw new SessionEndedError('gone');
      if (this.fresh(current)) return current; // another instance has just rotated it
      return await this.rotate(cookie, current, clientIp);
    } finally {
      await this.store.releaseLock(lockKey, owner).catch(() => undefined);
    }
  }

  private async rotate(
    cookie: string,
    current: SessionRecord,
    clientIp: string,
  ): Promise<SessionRecord> {
    let auth: AuthSession;
    try {
      auth = await this.identity.refresh(current.refreshToken, clientIp);
    } catch (error) {
      const failure = classify(error);
      if (failure.status === 401) {
        refreshOutcomes().add(1, { outcome: 'rejected' });
        await this.store.delete(cookie).catch(() => undefined);
        throw new SessionEndedError('refresh_rejected');
      }
      refreshOutcomes().add(1, { outcome: 'transient_failure' });
      this.logger.warn(`token refresh failed (${failure.code}); session kept`);
      if (current.accessExp > this.clock.nowMs()) return current; // still valid: carry on with it
      throw this.unavailable(failure.retryAfterMs);
    }

    const now = this.clock.nowMs();
    const next: SessionRecord = {
      ...current,
      sessionId: auth.sessionId,
      user: auth.user,
      accessToken: auth.accessToken.token,
      accessExp: now + auth.accessToken.expiresIn * 1_000,
      refreshToken: auth.refreshToken,
      tokenVersion: current.tokenVersion + 1,
    };
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      try {
        const result = await this.store.compareAndSet(
          cookie,
          current.tokenVersion,
          next,
          ttlMs(next, now),
        );
        if (result === 'ok') {
          refreshOutcomes().add(1, { outcome: 'rotated' });
          return next;
        }
        if (result === 'gone') throw new SessionEndedError('gone');
        // someone else wrote a newer version: theirs wins
        const newer = await this.store.get(cookie);
        if (newer) return newer;
        throw new SessionEndedError('gone');
      } catch (error) {
        if (error instanceof SessionEndedError) throw error;
        this.logger.warn(
          `session write after refresh failed (attempt ${attempt})`,
        );
      }
    }
    // the rotated tokens cannot be stored and the old refresh token is spent: end the session (fail closed)
    refreshOutcomes().add(1, { outcome: 'store_lost' });
    await this.store.delete(cookie).catch(() => undefined);
    throw new SessionEndedError('store_lost');
  }

  private async waitForRotation(
    cookie: string,
    seen: SessionRecord,
  ): Promise<SessionRecord> {
    const until = performance.now() + this.settings.session.refreshWaitMs;
    while (performance.now() < until) {
      await sleepMs(25 + Math.floor(Math.random() * 25));
      const latest = await this.store.get(cookie).catch(() => {
        throw this.unavailable();
      });
      if (!latest) throw new SessionEndedError('gone');
      if (latest.tokenVersion > seen.tokenVersion || this.fresh(latest))
        return latest;
    }
    if (seen.accessExp > this.clock.nowMs()) return seen;
    throw this.unavailable();
  }

  private unavailable(retryAfterMs?: number): BffProblem {
    return new BffProblem('session_unavailable', {
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((retryAfterMs ?? 1_000) / 1_000),
      ),
    });
  }
}

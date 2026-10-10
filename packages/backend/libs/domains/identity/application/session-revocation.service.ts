import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { SESSION_REPOSITORY, type SessionRepository } from '../domain/ports';
import { RevocationMarkers } from '../infra/sessions/revocation-markers';

/**
 * Ends sessions. The durable record is written first and the Redis marker second; a marker failure surfaces as an
 * error and the idempotent operation can simply be repeated (R-02, FR-037). Scoped to the owning user in every
 * lookup, so another user's session id is "not found" (III.4).
 */
@Injectable()
export class SessionRevocationService {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    private readonly markers: RevocationMarkers,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Revokes one session by id without an owner check; only for flows that already hold proof of the session. */
  async revokeBySid(sid: string, reason: string): Promise<void> {
    await this.sessions.revoke(sid, reason, this.clock.now());
    await this.markers.mark(sid, reason);
  }

  /** `false` when the session does not exist or belongs to someone else. Idempotent for an already revoked one. */
  async revokeSession(
    userId: string,
    sessionId: string,
    reason: string,
  ): Promise<boolean> {
    const session = await this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return false;
    await this.revokeBySid(sessionId, reason);
    return true;
  }

  /** Returns how many sessions were revoked now (already revoked ones are not counted). */
  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    const active = (await this.sessions.listForUser(userId)).filter(
      (s) => !s.revokedAt,
    );
    for (const session of active) await this.revokeBySid(session.sid, reason);
    return active.length;
  }
}

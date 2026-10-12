import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  SESSION_REPOSITORY,
  type SessionRecord,
  type SessionRepository,
} from '../domain/ports';
import { epochSec, MAX_ACTIVE_SESSIONS } from '../domain/session-policy';

/** The signed-in user's own view of their sessions (FR-036, FR-037). */
@Injectable()
export class SessionAdminService {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Active (not revoked, not past the absolute lifetime) sessions of the user, newest first, at most 20. */
  async list(userId: string): Promise<SessionRecord[]> {
    const now = epochSec(this.clock.now());
    return (await this.sessions.listForUser(userId))
      .filter((s) => !s.revokedAt && s.absoluteExpiry > now)
      .slice(0, MAX_ACTIVE_SESSIONS);
  }
}

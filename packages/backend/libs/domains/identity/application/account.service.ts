import { Inject, Injectable } from '@nestjs/common';
import {
  SESSION_REPOSITORY,
  USER_REPOSITORY,
  type SessionRecord,
  type SessionRepository,
  type UserRepository,
} from '../domain/ports';
import { Domain_InvalidTokenError } from '../domain/errors';
import type { Role } from '../infra/models/user.model';

/** The signed-in user's own view of the account (`/auth/me`, session list). */
@Injectable()
export class AccountService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
  ) {}

  async profile(
    userId: string,
  ): Promise<{ id: string; email: string | null; role: Role }> {
    const user = await this.users.findById(userId);
    // A token for a user who no longer exists is just an invalid token.
    if (!user) throw new Domain_InvalidTokenError('unknown_user');
    return { id: user.id, email: user.email, role: user.role };
  }

  async activeSessions(userId: string): Promise<SessionRecord[]> {
    return (await this.sessions.listForUser(userId)).filter(
      (s) => !s.revokedAt,
    );
  }
}

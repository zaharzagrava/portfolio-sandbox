import { Inject, Injectable } from '@nestjs/common';
import { USER_REPOSITORY, type UserRepository } from '../domain/ports';
import { Domain_InvalidTokenError } from '../domain/errors';
import type { Role } from '../domain/role';

/** The signed-in user's own view of the account (`/auth/me`). */
@Injectable()
export class AccountService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  async profile(
    userId: string,
  ): Promise<{ id: string; email: string | null; role: Role }> {
    const user = await this.users.findById(userId);
    // A token for a user who no longer exists is just an invalid token.
    if (!user) throw new Domain_InvalidTokenError('unknown_user');
    return { id: user.id, email: user.email, role: user.role };
  }
}

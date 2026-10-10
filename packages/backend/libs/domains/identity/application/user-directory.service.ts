import { Inject, Injectable } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import { USER_REPOSITORY, type UserRepository } from '../domain/ports';
import { normalizeEmail } from '../domain/password-policy';
import type { Role } from '../infra/models/user.model';

export const USER_DIRECTORY_MAX_IDS = 500;

export interface UserSummaryDto {
  id: string;
  email: string | null;
  role: Role;
  createdAt: Date;
}

export class TooManyIdsError extends AppError {
  constructor(count: number) {
    super({
      status: 400,
      code: 'too_many_ids',
      title: 'Bad Request',
      detail: `At most ${USER_DIRECTORY_MAX_IDS} user ids per lookup, got ${count}.`,
      area: ErrorArea.FATAL,
    });
  }
}

/**
 * The way other domains read user data (IX.7 R1): a batch by id and a lookup by address, returning a summary and
 * never the table. The principal of a request carries no e-mail (claims only), so callers that need one ask here.
 */
@Injectable()
export class UserDirectoryService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  /** One read; unknown and soft-deleted ids are absent from the map. */
  async getUsersByIds(ids: string[]): Promise<Map<string, UserSummaryDto>> {
    const unique = [...new Set(ids)];
    if (unique.length > USER_DIRECTORY_MAX_IDS)
      throw new TooManyIdsError(unique.length);
    const found = await this.users.findByIds(unique);
    return new Map(
      found.map((u) => [
        u.id,
        { id: u.id, email: u.email, role: u.role, createdAt: u.createdAt },
      ]),
    );
  }

  async findByEmail(email: string): Promise<UserSummaryDto | null> {
    const user = await this.users.findByEmail(normalizeEmail(email));
    return user
      ? {
          id: user.id,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
        }
      : null;
  }
}

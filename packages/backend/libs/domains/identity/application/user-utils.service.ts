import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../domain/authenticated-user';
import type { RequestWithUser } from '../api/request-with-user';
import { NotFoundError } from '@app/common/errors';

@Injectable()
export class UserUtilsService {
  public getUser(request: RequestWithUser): AuthenticatedUser {
    if (!request.user) {
      throw new NotFoundError('User not found');
    }

    return request.user;
  }

  public getUserOptional(request: RequestWithUser): AuthenticatedUser | null {
    if (!request.user) {
      return null;
    }

    return request.user;
  }
}

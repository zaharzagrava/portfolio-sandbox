import { Injectable } from '@nestjs/common';
import { UserRawDto } from '../api/users.dto';
import type { RequestWithUser } from '../api/request-with-user';
import { NotFoundError } from '@app/common/errors/error.types';

@Injectable()
export class UserUtilsService {
  public getUser(request: RequestWithUser) {
    if (!request.user) {
      throw new NotFoundError('User not found');
    }

    return request.user;
  }

  public getUserOptional(request: RequestWithUser): UserRawDto | null {
    if (!request.user) {
      return null;
    }

    return request.user;
  }
}

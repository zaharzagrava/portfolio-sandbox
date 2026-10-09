import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import User, { Role, UserScope } from '../infra/models/user.model';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import * as _ from 'lodash';

@Injectable()
export class UsersService {
  private readonly l = new Logger(UsersService.name);

  constructor(@InjectModel(User) private readonly userModel: typeof User) {}
}

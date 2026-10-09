import {
  Body,
  Controller,
  Get,
  Request,
  Logger,
  Post,
  Res,
  Response as NestResponse,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from './decorators/firewall.decorator';
import type { Response } from 'express';
import type { RequestWithUser } from './request-with-user';
import { UserUtilsService } from '../application/user-utils.service';
import { UsersService } from '../application/users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  private readonly l = new Logger(UsersController.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly userUtilsService: UserUtilsService,
  ) {}
}

import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FlagsClient } from '../infra/flags.client';
import { contextFromRequest } from '../domain/flags-context';

const FLAG = 'flags:require';

/** Routes behind a flag look like they don't exist (404) until the flag is on for the caller. */
@Injectable()
export class FlagGuard implements CanActivate {
  constructor(
    private readonly flags: FlagsClient,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const key = this.reflector.get<string>(FLAG, ctx.getHandler());
    if (
      key &&
      !this.flags.isEnabled(
        key,
        contextFromRequest(ctx.switchToHttp().getRequest()),
      )
    )
      throw new NotFoundException();
    return true;
  }
}

export const RequireFlag = (key: string) =>
  applyDecorators(SetMetadata(FLAG, key), UseGuards(FlagGuard));

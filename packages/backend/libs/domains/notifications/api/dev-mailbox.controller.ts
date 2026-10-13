import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { memoryMailbox } from '../domain/mailbox';

/** Available only outside production and only when `DEV_MAILBOX_ENABLED=true`; evaluated per request. */
export const devMailboxEnabled = (
  env: NodeJS.ProcessEnv = process.env,
): boolean =>
  env.NODE_ENV !== 'production' && env.DEV_MAILBOX_ENABLED === 'true';

/** W01 B-7: the e-mail that the memory provider "sent", so end-to-end tests can follow a reset link. */
@ApiExcludeController()
@Controller('dev/mailbox')
export class DevMailboxController {
  @Get()
  list(@Query('to') to?: string) {
    if (!devMailboxEnabled()) throw new NotFoundException();
    return {
      messages: memoryMailbox.list(typeof to === 'string' ? to : undefined),
    };
  }
}

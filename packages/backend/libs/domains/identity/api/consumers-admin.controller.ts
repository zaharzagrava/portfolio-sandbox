import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  consumerRedriveSchema,
  type ConsumerView,
} from '@marketplace-sandbox/contracts';
import {
  ConsumerAdminService,
  ConsumerNotFoundError,
  InvalidReplaySinceError,
  NotReplayableError,
} from '@app/infrastructure/projections/consumer-admin.service';
import { Firewall } from './decorators/firewall.decorator';
import { User } from './decorators/user.decorator';
import type { AuthenticatedUser } from '../domain/authenticated-user';
import {
  Domain_ConsumerNotFoundError,
  Domain_ConsumerNotReplayableError,
  Domain_ConsumerRequestInvalidError,
} from '../domain/consumer-errors';
import { Role } from '../domain/role';

/** Every consumer route needs the admin role and a live (not revoked) session, reads included (J01 control surface). */
const ADMIN_SENSITIVE = { roles: [Role.ADMIN], sensitive: true };

/** Maps the service's typed refusals to the problem+json answers of the contract. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConsumerNotFoundError)
      throw new Domain_ConsumerNotFoundError();
    if (error instanceof InvalidReplaySinceError)
      throw new Domain_ConsumerRequestInvalidError('since', error.reason);
    if (error instanceof NotReplayableError)
      throw new Domain_ConsumerNotReplayableError();
    throw error;
  }
}

/**
 * Operator routes over `ConsumerAdminService` (S53, J01 control surface): pause, resume, replay and dead-letter
 * redrive of a consumer group. Lives in the identity operator module because infrastructure may not import the
 * auth guards; all logic is in the service.
 */
@ApiTags('admin')
@Controller('admin/consumers')
export class ConsumersAdminController {
  constructor(private readonly consumers: ConsumerAdminService) {}

  @Firewall(ADMIN_SENSITIVE)
  @Get(':group')
  one(@Param('group') group: string): Promise<ConsumerView> {
    return guarded(() => this.consumers.view(group));
  }

  @Firewall(ADMIN_SENSITIVE)
  @Post(':group/pause')
  @HttpCode(HttpStatus.OK)
  pause(
    @Param('group') group: string,
    @User() user: AuthenticatedUser,
  ): Promise<ConsumerView> {
    return guarded(() => this.consumers.pause(group, user.id));
  }

  @Firewall(ADMIN_SENSITIVE)
  @Post(':group/resume')
  @HttpCode(HttpStatus.OK)
  resume(@Param('group') group: string): Promise<ConsumerView> {
    return guarded(() => this.consumers.resume(group));
  }

  @Firewall(ADMIN_SENSITIVE)
  @Post(':group/replay')
  @HttpCode(HttpStatus.ACCEPTED)
  async replay(
    @Param('group') group: string,
    @Body() body: { since?: unknown },
    @User() user: AuthenticatedUser,
  ): Promise<{ accepted: true }> {
    await guarded(() =>
      this.consumers.replay(group, String(body?.since ?? ''), user.id),
    );
    return { accepted: true };
  }

  @Firewall(ADMIN_SENSITIVE)
  @Post(':group/dlq/redrive')
  @HttpCode(HttpStatus.ACCEPTED)
  async redrive(
    @Param('group') group: string,
    @Body() body: unknown,
  ): Promise<{ requeued: number }> {
    const parsed = consumerRedriveSchema.safeParse(body ?? {});
    if (!parsed.success)
      throw new Domain_ConsumerRequestInvalidError('limit', 'invalid');
    return guarded(() => this.consumers.redrive(group, parsed.data.limit));
  }
}

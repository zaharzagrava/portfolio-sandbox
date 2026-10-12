import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from './decorators/firewall.decorator';
import { User } from './decorators/user.decorator';
import type { AuthenticatedUser } from '../domain/authenticated-user';
import { SessionAdminService } from '../application/session-admin.service';
import { SessionRevocationService } from '../application/session-revocation.service';
import { Domain_SessionNotFoundError } from '../domain/errors';
import { SessionListItemDto } from './sessions.dto';

/** The signed-in user's own sessions: list them, end one (FR-036, FR-037). */
@ApiTags('auth')
@Controller('auth/sessions')
export class SessionsController {
  constructor(
    private readonly admin: SessionAdminService,
    private readonly revocation: SessionRevocationService,
  ) {}

  @Firewall()
  @Get()
  async list(@User() user: AuthenticatedUser): Promise<SessionListItemDto[]> {
    return (await this.admin.list(user.id)).map((s) => ({
      sessionId: s.sid,
      device: s.device ?? null,
      ip: s.ip ?? null,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt ?? null,
      current: s.sid === user.sessionId,
    }));
  }

  /** Another user's id answers exactly like an unknown one (III.4). */
  @Firewall({ sensitive: true })
  @Delete(':sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @User() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    if (!(await this.revocation.revokeSession(user.id, sessionId, 'revoked')))
      throw new Domain_SessionNotFoundError();
  }
}

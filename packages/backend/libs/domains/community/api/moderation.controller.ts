import {
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, Role, User, UserRawDto } from '@app/domains/identity';
import { ModerationService } from '../application/moderation.service';

/** Shadow bans (S25 FR-051): `ADMIN` and `MODERATOR` only; both calls are idempotent. */
@ApiTags('discussions')
@Controller('moderation/shadow-bans')
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Firewall({ roles: [Role.ADMIN, Role.MODERATOR] })
  @HttpCode(204)
  @Put(':userId')
  async ban(
    @Param('userId', ParseUUIDPipe) userId: string,
    @User() moderator: UserRawDto,
  ): Promise<void> {
    await this.moderation.ban(moderator.id, userId.toLowerCase());
  }

  @Firewall({ roles: [Role.ADMIN, Role.MODERATOR] })
  @HttpCode(204)
  @Delete(':userId')
  async lift(@Param('userId', ParseUUIDPipe) userId: string): Promise<void> {
    await this.moderation.lift(userId.toLowerCase());
  }
}

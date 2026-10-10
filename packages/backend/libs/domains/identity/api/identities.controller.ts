import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../domain/authenticated-user';
import { FederatedIdentityService } from '../application/federated-identity.service';
import { Firewall } from './decorators/firewall.decorator';
import { User } from './decorators/user.decorator';

/** The signed-in user's linked sign-in methods. */
@ApiTags('auth')
@Controller('auth/identities')
export class IdentitiesController {
  constructor(private readonly identities: FederatedIdentityService) {}

  @Firewall()
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@User() user: AuthenticatedUser) {
    return this.identities.list(user.id);
  }

  @Firewall({ sensitive: true })
  @Delete(':identityId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlink(
    @User() user: AuthenticatedUser,
    @Param('identityId') identityId: string,
  ) {
    await this.identities.unlink(user.id, identityId);
  }
}

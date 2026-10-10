import { Controller, Get, Module, Post } from '@nestjs/common';
import { AuthModule } from '../auth.module';
import { Firewall } from '../api/decorators/firewall.decorator';
import { User } from '../api/decorators/user.decorator';
import { Role } from '../infra/models/user.model';

/**
 * Routes that exist only in identity's own specs: one per `Firewall` flavour, echoing the principal the guards built.
 * Other capabilities guard their routes the same way, so this is what "protected route" means to the identity specs.
 */
@Controller('probe')
export class AuthProbeController {
  @Firewall({ anonymous: true })
  @Get('optional')
  optional(@User() user: unknown) {
    return { user };
  }

  @Firewall()
  @Get('ordinary')
  ordinary(@User() user: unknown) {
    return { user };
  }

  @Firewall({ sensitive: true })
  @Post('sensitive')
  sensitive(@User() user: unknown) {
    return { user };
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin')
  admin(@User() user: unknown) {
    return { user };
  }
}

@Module({ imports: [AuthModule], controllers: [AuthProbeController] })
export class AuthProbeModule {}

import {
  CanActivate,
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  clockUpdateSchema,
  type ClockView,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { AppError, ErrorArea } from '@app/common/errors/error.types';
import { Fatal_NotFoundError } from '@app/common/errors/error.types';
import { ClockService } from '@app/infrastructure/clock';
import { Role } from '../domain/role';
import { Firewall } from './decorators/firewall.decorator';

/** Class-level guard: it runs before the auth guards, so the routes do not exist (404) unless the control is on. */
@Injectable()
export class ClockControlEnabledGuard implements CanActivate {
  constructor(private readonly config: ApiConfigService) {}

  canActivate(): boolean {
    if (this.config.get('clock_control') !== 'enabled')
      throw new Fatal_NotFoundError();
    return true;
  }
}

class InvalidClockUpdateError extends AppError {
  constructor(fields: string[]) {
    super({
      status: 422,
      code: 'invalid_clock_update',
      title: 'Unprocessable Entity',
      detail: 'The clock update is not valid.',
      area: ErrorArea.DOMAIN,
      extensions: { errors: fields.map((field) => ({ field, code: 'invalid' })) },
    });
  }
}

const ADMIN = { roles: [Role.ADMIN] };

/**
 * Journey control surface (J01 G-32, S54.R-21/22): admin view and control of the platform clock. It lives here with the
 * other operator routes (`jobs`, `consumers`), because the guards are identity's; the clock itself is infrastructure.
 */
@ApiTags('admin')
@UseGuards(ClockControlEnabledGuard)
@Controller('admin/clock')
export class ClockAdminController {
  constructor(private readonly clock: ClockService) {}

  @Firewall(ADMIN)
  @Get()
  view(): ClockView {
    return this.clock.view();
  }

  @Firewall(ADMIN)
  @HttpCode(200)
  @Put()
  update(@Body() body: unknown): Promise<ClockView> {
    const parsed = clockUpdateSchema.safeParse(body);
    if (!parsed.success)
      throw new InvalidClockUpdateError([
        ...new Set(
          parsed.error.issues.flatMap((i) =>
            i.code === 'unrecognized_keys' ? i.keys : [String(i.path[0] ?? 'body')],
          ),
        ),
      ]);
    return 'advanceSeconds' in parsed.data
      ? this.clock.advance(parsed.data.advanceSeconds)
      : this.clock.reset();
  }
}

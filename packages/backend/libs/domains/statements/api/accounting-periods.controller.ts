import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
  AccountingPeriod,
  PeriodCloseAccepted,
} from '@marketplace-sandbox/contracts';
import { User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { AccountingPeriodService } from '../application/accounting-period.service';
import { PeriodCloseService } from '../application/period-close.service';
import { VerificationService } from '../application/verification.service';
import { AdminOnly } from './admin-only.decorator';
import { adminListQuerySchema, monthParamSchema } from './statements.dto';
import { ZodPipe } from './zod.pipe';

/** The period operator API (S16 contracts/http.md): platform `admin` only; there is no reopen and no delete route. */
@ApiTags('statements')
@Controller('admin/accounting-periods')
export class AccountingPeriodsController {
  constructor(
    private readonly periods: AccountingPeriodService,
    private readonly closing: PeriodCloseService,
    private readonly verification: VerificationService,
  ) {}

  @AdminOnly()
  @RateLimit('statements.admin.read')
  @Get()
  list(
    @Query(new ZodPipe(adminListQuerySchema))
    query: ReturnType<typeof adminListQuerySchema.parse>,
  ) {
    return this.periods.list(query);
  }

  @AdminOnly()
  @RateLimit('statements.admin.read')
  @Get(':month')
  one(
    @Param('month', new ZodPipe(monthParamSchema)) month: string,
  ): Promise<AccountingPeriod> {
    return this.periods.get(month);
  }

  @AdminOnly()
  @RateLimit('statements.admin.read')
  @Get(':month/findings')
  findings(
    @Param('month', new ZodPipe(monthParamSchema)) month: string,
    @Query(new ZodPipe(adminListQuerySchema))
    query: ReturnType<typeof adminListQuerySchema.parse>,
  ) {
    return this.verification.findingsPage(month, query);
  }

  @AdminOnly({ sensitive: true })
  @RateLimit('statements.admin.write')
  @Idempotent()
  @HttpCode(HttpStatus.ACCEPTED)
  @Post(':month/close')
  close(
    @User() user: AuthenticatedUser,
    @Param('month', new ZodPipe(monthParamSchema)) month: string,
  ): Promise<PeriodCloseAccepted> {
    return this.closing.request(month, `admin:${user.id}`);
  }
}

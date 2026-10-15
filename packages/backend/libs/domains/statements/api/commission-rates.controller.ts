import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type {
  CommissionRateChangeResult,
  CommissionRateAsOf,
} from '@marketplace-sandbox/contracts';
import { User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { CommissionRateService } from '../application/commission-rate.service';
import { AdminOnly } from './admin-only.decorator';
import {
  rateAsOfQuerySchema,
  rateHistoryQuerySchema,
  setRateBodySchema,
} from './statements.dto';
import { ZodPipe } from './zod.pipe';

/** The commission-rate operator API (S16 contracts/http.md): platform `admin` only, thin, writes idempotent. */
@ApiTags('statements')
@Controller('admin/commission-rates')
export class CommissionRatesController {
  constructor(private readonly rates: CommissionRateService) {}

  @AdminOnly({ sensitive: true })
  @RateLimit('statements.admin.write')
  @Idempotent()
  @Post()
  async setRate(
    @User() user: AuthenticatedUser,
    @Body(new ZodPipe(setRateBodySchema))
    body: ReturnType<typeof setRateBodySchema.parse>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CommissionRateChangeResult> {
    const result = await this.rates.setRate({
      shopId: body.shopId?.toLowerCase(),
      category: body.category,
      rateBps: body.rateBps,
      validFrom: new Date(body.validFrom),
      validTo: body.validTo ? new Date(body.validTo) : undefined,
      reason: body.reason,
      actorId: user.id,
    });
    res.status(result.changed ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }

  @AdminOnly()
  @RateLimit('statements.admin.read')
  @Get()
  history(
    @Query(new ZodPipe(rateHistoryQuerySchema))
    query: ReturnType<typeof rateHistoryQuerySchema.parse>,
  ) {
    return this.rates.history({
      ...query,
      shopId: query.shopId?.toLowerCase(),
    });
  }

  @AdminOnly()
  @RateLimit('statements.admin.read')
  @Get('as-of')
  async asOf(
    @Query(new ZodPipe(rateAsOfQuerySchema))
    query: ReturnType<typeof rateAsOfQuerySchema.parse>,
  ): Promise<CommissionRateAsOf> {
    const found = await this.rates.asOf({
      shopId: query.shopId?.toLowerCase(),
      category: query.category,
      validAt: new Date(query.validAt),
      knownAt: query.knownAt ? new Date(query.knownAt) : undefined,
    });
    if (!found) throw new Error('no commission rate resolves');
    return found;
  }
}

import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Firewall, Role } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { CommissionRateService } from '../application/commission-rate.service';
import { StatementService } from '../application/statement.service';
import { streamStatementCsv } from '../infra/statement-export';
import { ReportingPool } from '../infra/reporting-pool';
import { SetCommissionRateDto } from './statements.dto';

const MONTH = /^\d{4}-\d{2}$/;

@ApiTags('statements')
@Controller()
export class StatementsController {
  constructor(
    private readonly statements: StatementService,
    private readonly rates: CommissionRateService,
    private readonly reporting: ReportingPool,
  ) {}

  /** `?knownAt=2026-04-01T00:00:00Z` → the statement exactly as we would have produced it then. */
  @ShopScoped('payouts.read')
  @Get('shops/:shopId/statements/:month')
  statement(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('month') month: string, @Query('knownAt') knownAt?: string) {
    if (!MONTH.test(month)) throw new BadRequestException('month must be YYYY-MM');
    const known = knownAt ? new Date(knownAt) : undefined;
    if (known && Number.isNaN(known.getTime())) throw new BadRequestException('knownAt must be an ISO date');
    return this.statements.statement(shopId, `${month}-01`, known);
  }

  @ShopScoped('payouts.read')
  @RateLimit('exports.concurrent')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Get('shops/:shopId/statements/:month/lines.csv')
  async export(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('month') month: string, @Res() res: Response) {
    if (!MONTH.test(month)) throw new BadRequestException('month must be YYYY-MM');
    res.setHeader('Content-Disposition', `attachment; filename="statement-${month}.csv"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await streamStatementCsv(this.reporting.pool, shopId, `${month}-01`, res);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @HttpCode(204)
  @Post('admin/commission-rates')
  async setRate(@Body() body: SetCommissionRateDto) {
    await this.rates.setRate({ ...body, validFrom: new Date(body.validFrom), validTo: body.validTo ? new Date(body.validTo) : undefined });
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/commission-rates')
  history(@Query('shopId') shopId: string | undefined, @Query('category') category = '*') {
    return this.rates.history(shopId ?? null, category);
  }
}

import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { StatementExportService } from '../application/statement-export.service';
import { StatementService } from '../application/statement.service';
import { sendCsv } from '../infra/streaming-response';
import { StatementsLifecycle } from '../infra/statements-lifecycle';
import { validationFailed } from '../domain/errors';
import {
  monthParamSchema,
  sellerListQuerySchema,
  shopIdParamSchema,
  statementQuerySchema,
} from './statements.dto';
import { ZodPipe } from './zod.pipe';

/** A malformed `shopId` is `400 validation_failed` before the shop guard looks anything up. */
@Injectable()
export class ShopIdFormatGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const shopId = ctx
      .switchToHttp()
      .getRequest<{ params: { shopId?: string } }>().params.shopId;
    if (!shopIdParamSchema.safeParse(shopId).success)
      throw validationFailed(['shopId']);
    return true;
  }
}

/**
 * The seller's statements (S16 contracts/http.md): a member with `payouts.read` reads their own shop's statements
 * only; the guard decides who may (`404` for a non-member, `403` for the wrong role). Thin: one service call a route.
 */
@ApiTags('statements')
@UseGuards(ShopIdFormatGuard)
@Controller('shops/:shopId/statements')
export class StatementsController {
  constructor(
    private readonly statements: StatementService,
    private readonly exports: StatementExportService,
    private readonly lifecycle: StatementsLifecycle,
  ) {}

  @ShopScoped('payouts.read')
  @RateLimit('statements.read')
  @Get()
  list(
    @Param('shopId') shopId: string,
    @Query(new ZodPipe(sellerListQuerySchema))
    query: ReturnType<typeof sellerListQuerySchema.parse>,
  ) {
    return this.statements.list(shopId.toLowerCase(), query);
  }

  /** The statement as CSV, streamed with back-pressure; at most two at once per shop (fail closed). */
  @ShopScoped('payouts.read')
  @RateLimit('statements.read', 'statements.export.concurrent')
  @Get(':month/lines.csv')
  async export(
    @Param('shopId') shopId: string,
    @Param('month', new ZodPipe(monthParamSchema)) month: string,
    @Query(new ZodPipe(statementQuerySchema))
    query: ReturnType<typeof statementQuerySchema.parse>,
    @Res() res: Response,
  ): Promise<void> {
    const id = shopId.toLowerCase();
    const plan = await this.exports.prepare(id, month, query.knownAt);
    await sendCsv(res, plan.chunks, {
      filename: plan.filename,
      lifecycle: this.lifecycle,
      context: { shopId: id, month },
    });
  }

  /** `?knownAt=2026-04-01T00:00:00Z` → the statement exactly as we would have produced it then. */
  @ShopScoped('payouts.read')
  @RateLimit('statements.read')
  @Get(':month')
  statement(
    @Param('shopId') shopId: string,
    @Param('month', new ZodPipe(monthParamSchema)) month: string,
    @Query(new ZodPipe(statementQuerySchema))
    query: ReturnType<typeof statementQuerySchema.parse>,
  ) {
    return this.statements.statement(
      shopId.toLowerCase(),
      month,
      query.knownAt,
    );
  }
}

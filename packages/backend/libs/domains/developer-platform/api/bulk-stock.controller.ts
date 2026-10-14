import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import {
  BULK_LIMITS,
  bulkStockRequestSchema,
} from '@marketplace-sandbox/contracts';
import type { z } from 'zod';
import { ApiKeyAuth } from './api-key.guard';
import { contextOf, IDEMPOTENT_WIRE } from './api-support';
import { ZodBodyPipe } from './zod-body.pipe';
import { PublicApiInterceptor } from './public-api.interceptor';
import type { ResourceRequest } from './public-api.interceptor';
import { BulkStockService } from '../application/bulk-stock.service';

type BulkStockRequest = z.infer<typeof bulkStockRequestSchema>;

/** Cost of a bulk call: one unit per 100 items, at least one (FR-051). */
export const bulkCost = (req: { body?: unknown }): number => {
  const items = (req.body as { items?: unknown } | undefined)?.items;
  return Math.max(
    1,
    Math.ceil(
      (Array.isArray(items) ? items.length : 0) / BULK_LIMITS.chunkSize,
    ),
  );
};

/** Stock as deltas with operation ids (FR-046, apps/public-api): up to 100 items at once, more as a durable job. */
@ApiTags('public-api')
@ApiBearerAuth()
@UseInterceptors(PublicApiInterceptor)
@Controller('v1/stock/bulk')
export class BulkStockController {
  constructor(private readonly bulk: BulkStockService) {}

  @ApiKeyAuth('stock:write')
  @RateLimit({ policy: 'public-api.default', cost: bulkCost })
  @Idempotent({
    required: true,
    scope: (req) =>
      `shop:${(req as ResourceRequest).apiKey?.shopId}:POST /v1/stock/bulk`,
    wire: IDEMPOTENT_WIRE,
  })
  @Post()
  async submit(
    @Req() req: ResourceRequest,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodBodyPipe(bulkStockRequestSchema)) body: BulkStockRequest,
  ) {
    const result = await this.bulk.submit(contextOf(req), body.items);
    res.status(result.status);
    if (result.status === 202) res.setHeader('Location', result.location);
    return result.body;
  }

  @ApiKeyAuth('stock:write')
  @RateLimit('public-api.default')
  @Get(':jobId')
  job(@Req() req: ResourceRequest, @Param('jobId') jobId: string) {
    return this.bulk.job(contextOf(req), jobId);
  }
}

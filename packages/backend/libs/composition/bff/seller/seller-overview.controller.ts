import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import type { SellerOverviewResponse } from '@marketplace-sandbox/contracts';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { CredentialsGuard } from '../credentials/credentials.guard';
import type { RequestWithCredentials } from '../credentials/request-credentials';
import '../rate-limit-policies';
import { ZodPipe } from '../zod-pipe';
import { SellerOverviewService } from './seller-overview.service';

const shopIdSchema = z.string().uuid();
/** `days` is 7, 30 or 90 (default 30); anything else, including a repeated key, is `400 validation_failed`. */
const daysSchema = z
  .preprocess(
    (value) => (typeof value === 'number' ? String(value) : value),
    z.union([z.undefined(), z.enum(['7', '30', '90'])]),
  )
  .transform((value) => Number(value ?? '30'));

/** `GET /bff/seller/:shopId/overview` (W04 B-1): needs a session; per-seller data, never cached. */
@ApiTags('bff')
@Controller('bff')
export class SellerOverviewController {
  constructor(private readonly overview: SellerOverviewService) {}

  @UseGuards(CredentialsGuard)
  @RateLimit('bff.seller-overview.principal')
  @Get('seller/:shopId/overview')
  async get(
    @Param('shopId', new ZodPipe(shopIdSchema)) shopId: string,
    @Query('days', new ZodPipe(daysSchema)) days: number,
    @Req() req: RequestWithCredentials,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SellerOverviewResponse> {
    res.setHeader('Cache-Control', 'private, no-store');
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    return this.overview.load({
      shopId,
      days,
      credentials: req.credentials!,
      signal: controller.signal,
    });
  }
}

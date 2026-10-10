import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  pageQuerySchema,
  type PageQuery,
  type ProductPageResponse,
} from '@marketplace-sandbox/contracts';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { CredentialsGuard } from '../credentials/credentials.guard';
import type { RequestWithCredentials } from '../credentials/request-credentials';
import '../rate-limit-policies';
import { ZodPipe } from '../zod-pipe';
import { ProductPageService } from './product-page.service';

const productIdSchema = z.string().uuid();

/** REST aggregate for the web app and native clients (S48 contracts/http.md). The page holds per-visitor data: never cached. */
@ApiTags('bff')
@Controller('bff')
export class ProductPageController {
  constructor(private readonly pages: ProductPageService) {}

  @UseGuards(CredentialsGuard)
  @RateLimit('bff.product-page.principal')
  @Get('product-page/:productId')
  async get(
    @Param('productId', new ZodPipe(productIdSchema)) productId: string,
    @Query(new ZodPipe(pageQuerySchema)) query: PageQuery,
    @Req() req: RequestWithCredentials,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProductPageResponse> {
    res.setHeader('Cache-Control', 'private, no-store');
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    const result = await this.pages.load({
      productId,
      query,
      credentials: req.credentials!,
      signal: controller.signal,
    });
    res.setHeader(
      'Server-Timing',
      result.outcomes
        .filter((o) => o.status !== 'skipped')
        .map((o) => `${o.name};dur=${o.durationMs.toFixed(1)}`)
        .join(', '),
    );
    return result.body;
  }
}

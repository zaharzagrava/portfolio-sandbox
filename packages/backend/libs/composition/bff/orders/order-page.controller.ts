import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import type { OrderPageResponse } from '@marketplace-sandbox/contracts';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { CredentialsGuard } from '../credentials/credentials.guard';
import type { RequestWithCredentials } from '../credentials/request-credentials';
import '../rate-limit-policies';
import { ZodPipe } from '../zod-pipe';
import { OrderPageService } from './order-page.service';

const orderIdSchema = z.string().uuid();

/** `GET /bff/orders/:orderId` (W03 B-4): needs a session; per-buyer data, never cached. */
@ApiTags('bff')
@Controller('bff')
export class OrderPageController {
  constructor(private readonly pages: OrderPageService) {}

  @UseGuards(CredentialsGuard)
  @RateLimit('bff.order-page.principal')
  @Get('orders/:orderId')
  async get(
    @Param('orderId', new ZodPipe(orderIdSchema)) orderId: string,
    @Req() req: RequestWithCredentials,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderPageResponse> {
    res.setHeader('Cache-Control', 'private, no-store');
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    return this.pages.load({
      orderId,
      credentials: req.credentials!,
      signal: controller.signal,
    });
  }
}

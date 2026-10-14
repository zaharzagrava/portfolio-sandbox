import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  ragAskRequestSchema,
  type RagAskRequest,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { AskService } from '../application/ask.service';
import { AnonymousOrAuthenticated } from './knowledge-auth';
import { HttpSseSink } from './knowledge-stream';
import { ValidatedRequest } from './knowledge-validation';

/**
 * "Ask this product" (buyers, anonymous allowed) and the shop help center, both `text/event-stream`:
 * `sources → text… → done` | `not_found` | `refusal` | `error`. The controller issues no query and no lookup (II.1): it
 * binds the response to a sink and hands the question to `AskService`. Admission order: authentication (401) → request
 * validation (400, a guard so it runs before the limiter) → rate limit (429 / 503) → the service's own checks.
 */
@ApiTags('knowledge')
@Controller()
export class KnowledgeAskController {
  constructor(private readonly asks: AskService) {}

  @UseGuards(
    ValidatedRequest({ body: ragAskRequestSchema, uuidParams: ['productId'] }),
  )
  @AnonymousOrAuthenticated()
  @RateLimit('rag.ask')
  @Post('products/:productId/ask')
  async askProduct(
    @Param('productId') productId: string,
    @Body() body: RagAskRequest,
    @Req() req: Request & { user?: { id: string } },
    @Res() res: Response,
  ): Promise<void> {
    await this.asks.ask(
      req.user?.id ?? null,
      { kind: 'product', productId },
      body.question,
      new HttpSseSink(res),
    );
  }

  @UseGuards(ValidatedRequest({ body: ragAskRequestSchema }))
  @ShopScoped('shop.read')
  @RateLimit('rag.ask')
  @Post('shops/:shopId/knowledge/ask')
  async askShop(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: UserRawDto,
    @Body() body: RagAskRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.asks.ask(
      user.id,
      { kind: 'shop', shopId },
      body.question,
      new HttpSseSink(res),
    );
  }
}

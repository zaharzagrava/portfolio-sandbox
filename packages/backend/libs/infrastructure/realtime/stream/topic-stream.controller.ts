import {
  Controller,
  Get,
  Headers,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { StreamAuthGuard } from './stream-auth.guard';
import { StreamService } from './stream.service';

/**
 * GET /api/streams?topics=auction:abc,user:me  (text/event-stream). Thin: the guard authenticates, the rate limit
 * applies, and `StreamService` does the rest (contract: specs/domains/S51-realtime-push/contracts/stream-http.md).
 */
@Controller('streams')
export class TopicStreamController {
  constructor(private readonly streams: StreamService) {}

  @UseGuards(StreamAuthGuard)
  @RateLimit('realtime.connect')
  @Get()
  async stream(
    @Query() query: Record<string, unknown>,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.streams.open(req, res, query, lastEventId);
  }
}

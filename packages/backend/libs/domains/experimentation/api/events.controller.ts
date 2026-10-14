import { Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { IngestResult } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { IngestService } from '../application/ingest.service';
import { IngestBodyGuard } from './ingest-body.guard';
import { IngestBodyPipe, IngestPayload } from './ingest-body.pipe';
import { ingestContext } from './ingest-context';

type CallerRequest = {
  user?: { id?: string; email?: string; role?: string };
  headers: Record<string, string | string[] | undefined>;
};

/** `POST /api/events`: the fallback of the edge collector. Anonymous callers allowed, rate limited, one service call. */
@ApiTags('analytics')
@Controller()
export class EventsController {
  constructor(
    private readonly ingest: IngestService,
    private readonly config: ApiConfigService,
  ) {}

  @Firewall({ anonymous: true })
  @UseGuards(IngestBodyGuard)
  @RateLimit('analytics.ingest')
  @Post('events')
  @HttpCode(202)
  events(
    @IngestPayload(IngestBodyPipe) events: unknown[],
    @Req() req: CallerRequest,
  ): Promise<IngestResult> {
    return this.ingest.ingest(
      events,
      ingestContext(req, this.config.get('flags_edge_secret')),
    );
  }
}

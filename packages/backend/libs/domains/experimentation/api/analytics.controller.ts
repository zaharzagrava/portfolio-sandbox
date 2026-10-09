import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { buffer } from 'node:stream/consumers';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, Role } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { AnalyticsService } from '../application/analytics.service';
import type { ExperimentDef } from '../domain/experiments';

type Req = {
  user?: { id: string };
  headers: Record<string, string | undefined>;
};

@ApiTags('analytics')
@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Fallback ingest (edge `/collect` is primary). sendBeacon posts text/plain, so the body may arrive as a string. */
  @Firewall({ anonymous: true, skipThrottle: true })
  @RateLimit('search.query')
  @Post('events')
  @HttpCode(202)
  async ingest(
    @Body() body: unknown,
    @Req() req: Req & NodeJS.ReadableStream & { rawBody?: Buffer },
  ) {
    // sendBeacon sends text/plain (no CORS preflight); Express has no parser for it, so read the stream.
    let parsed = body;
    if (String(req.headers['content-type'] ?? '').startsWith('text/plain')) {
      try {
        parsed = JSON.parse(
          (req.rawBody ?? (await buffer(req))).toString('utf8'),
        );
      } catch {
        throw new BadRequestException('Body is not JSON');
      }
    }
    return this.analytics.ingest(parsed, {
      userId: req.user?.id,
      country: req.headers['cf-ipcountry'],
      platform: req.headers['x-client-platform'],
    });
  }

  /** Variant per running experiment for this unit (user id when logged in, else X-Anonymous-Id). */
  @Firewall({ anonymous: true })
  @Get('experiments/assignments')
  assignments(@Req() req: Req) {
    return this.analytics.assignments(
      req.user?.id ?? req.headers['x-anonymous-id'] ?? '',
    );
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Put('admin/experiments/:key')
  @HttpCode(204)
  upsert(
    @Param('key') key: string,
    @Body()
    body: Omit<ExperimentDef, 'key'> & { metric: string; description?: string },
  ) {
    return this.analytics.upsertExperiment({ ...body, key });
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/experiments/:key/results')
  results(@Param('key') key: string) {
    return this.analytics.results(key);
  }
}

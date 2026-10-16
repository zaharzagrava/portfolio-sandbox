import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from '@app/domains/identity';
import { LiveHistoryService } from '../application/live-history.service';
import { UuidParamPipe } from './pipes';

/** `GET /live/:streamId/history?minute&limit&cursor` (FR-040): anonymous, one minute per page. */
@ApiTags('live')
@Controller()
export class LiveHistoryController {
  constructor(private readonly history: LiveHistoryService) {}

  @Firewall({ anonymous: true })
  @Get('live/:streamId/history')
  page(
    @Param('streamId', new UuidParamPipe('streamId')) streamId: string,
    @Query() query: { minute?: unknown; limit?: unknown; cursor?: unknown },
  ) {
    return this.history.page(streamId, query);
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { IssueResolutionService } from '../application/issue-resolution.service';
import { ReconciliationQueryService } from '../application/reconciliation-query.service';
import { AdminOnly } from './admin-only.decorator';
import {
  ListIssuesQueryDto,
  ListRunsQueryDto,
  ResolveIssueDto,
} from './ledger.dto';

/** The finance operator API (S14 contracts/http.md): platform `admin` only, thin, one service call per route. */
@ApiTags('finance')
@Controller('finance/reconciliation')
export class ReconciliationController {
  constructor(
    private readonly queries: ReconciliationQueryService,
    private readonly resolution: IssueResolutionService,
  ) {}

  @AdminOnly()
  @RateLimit('finance.admin.read')
  @Get('runs')
  runs(@Query() query: ListRunsQueryDto) {
    return this.queries.runs(query);
  }

  @AdminOnly()
  @RateLimit('finance.admin.read')
  @Get('issues')
  issues(@Query() query: ListIssuesQueryDto) {
    return this.queries.issues(query);
  }

  @AdminOnly()
  @RateLimit('finance.admin.write')
  @Idempotent()
  @HttpCode(200)
  @Post('issues/:issueId/resolve')
  resolve(
    @User() user: AuthenticatedUser,
    @Param('issueId', ParseUUIDPipe) issueId: string,
    @Body() body: ResolveIssueDto,
  ) {
    return this.resolution.resolve(issueId, user.id, body);
  }
}

import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Body,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  reindexListQuerySchema,
  synonymsPutRequestSchema,
  type ReindexRun,
  type SearchIndexStatus,
  type SearchQualityReport,
  type Synonyms,
} from '@marketplace-sandbox/contracts';
import { Firewall, Role, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { CancelReindexService } from '../application/reindex/cancel-reindex.service';
import {
  GetRunsService,
  toRunView,
} from '../application/reindex/get-runs.service';
import {
  StartReindexService,
  type AcceptedRun,
} from '../application/reindex/start-reindex.service';
import { SearchIndexStatusService } from '../application/search-index-status.service';
import { SearchQualityService } from '../application/search-quality.service';
import {
  SynonymsService,
  type SynonymsPutResult,
} from '../application/synonyms.service';
import { SearchValidationError } from '../domain/search-errors';

/**
 * Index administration (S32 FR-031 to FR-038, FR-041): status, reindex runs and rollback. Administrators only, 30 calls
 * a minute each, failing closed when the limiter store is down. One application call per route.
 */
@ApiTags('search-admin')
@Controller('admin/search')
export class SearchIndexAdminController {
  constructor(
    private readonly status: SearchIndexStatusService,
    private readonly start: StartReindexService,
    private readonly cancelRun: CancelReindexService,
    private readonly runs: GetRunsService,
    private readonly synonymSet: SynonymsService,
    private readonly qualityReport: SearchQualityService,
  ) {}

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('discovery.search-admin')
  @Get('index')
  index(): Promise<SearchIndexStatus> {
    return this.status.status();
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('discovery.search-admin')
  @HttpCode(202)
  @Post('reindex')
  reindex(@User() user: AuthenticatedUser): Promise<AcceptedRun> {
    return this.start.startReindex(user.id);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('discovery.search-admin')
  @Get('reindex')
  list(@Query() query: Record<string, unknown>) {
    const parsed = reindexListQuerySchema.safeParse(query);
    if (!parsed.success)
      throw new SearchValidationError([
        ...new Set(
          parsed.error.issues.flatMap((i) =>
            i.code === 'unrecognized_keys'
              ? i.keys
              : [String(i.path[0] ?? 'query')],
          ),
        ),
      ]);
    return this.runs.list(parsed.data.limit ?? 20, parsed.data.cursor);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('discovery.search-admin')
  @Get('reindex/:runId')
  one(@Param('runId', ParseUUIDPipe) runId: string): Promise<ReindexRun> {
    return this.runs.get(runId);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('discovery.search-admin')
  @HttpCode(200)
  @Post('reindex/:runId/cancel')
  async cancel(
    @User() user: AuthenticatedUser,
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<ReindexRun> {
    return toRunView(await this.cancelRun.cancel(runId, user.id));
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('discovery.search-admin')
  @Get('quality')
  quality(
    @Query() query: Record<string, unknown>,
  ): Promise<SearchQualityReport> {
    return this.qualityReport.report(query);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('discovery.search-admin')
  @Get('synonyms')
  synonyms(): Promise<Synonyms> {
    return this.synonymSet.get();
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('discovery.search-admin')
  @Put('synonyms')
  putSynonyms(
    @User() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<SynonymsPutResult> {
    const parsed = synonymsPutRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new SearchValidationError([
        ...new Set(
          parsed.error.issues.flatMap((i) =>
            i.code === 'unrecognized_keys'
              ? i.keys
              : [String(i.path[0] ?? 'body')],
          ),
        ),
      ]);
    return this.synonymSet.put(parsed.data, user.id);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @RateLimit('discovery.search-admin')
  @HttpCode(202)
  @Post('rollback')
  rollback(@User() user: AuthenticatedUser): Promise<AcceptedRun> {
    return this.start.startRollback(user.id);
  }
}

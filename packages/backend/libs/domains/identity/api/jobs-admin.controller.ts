import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { isUUID } from 'class-validator';
import {
  ADMIN_JOB_TYPES,
  createAdminJobSchema,
  type AdminJob,
} from '@marketplace-sandbox/contracts';
import { Idempotent } from '@app/infrastructure/idempotency';
import {
  IdempotencyKeyConflictError,
  InvalidCursorError,
  InvalidJobPayloadError,
  JobsAdminService,
  JobsService,
  type JobType,
} from '@app/infrastructure/jobs';
import { Firewall } from './decorators/firewall.decorator';
import { User } from './decorators/user.decorator';
import type { AuthenticatedUser } from '../domain/authenticated-user';
import {
  Domain_InvalidCursorError,
  Domain_InvalidJobPayloadError,
  Domain_JobKeyReuseError,
  Domain_JobNotFoundError,
  Domain_JobTypeNotAllowedError,
  Domain_ScheduleNotFoundError,
  Domain_ValidationFailedError,
} from '../domain/errors';
import { Role } from '../domain/role';
import {
  JobPageDto,
  JobTypeStatsDto,
  ListJobsQueryDto,
  ScheduleDto,
  ScheduleStateDto,
  toJobDto,
  toScheduleDto,
  toStatsDto,
} from './jobs-admin.dto';

const ADMIN = { roles: [Role.ADMIN] };
const ADMIN_SENSITIVE = { roles: [Role.ADMIN], sensitive: true };

/**
 * Operator routes over `JobsAdminService` (S49 follow-up F-S49-1): ADMIN only, thin, DTOs only (never a payload).
 * Mutations are sensitive: a revoked admin session is refused at once.
 */
@ApiTags('admin')
@Controller('admin')
export class JobsAdminController {
  constructor(
    private readonly admin: JobsAdminService,
    private readonly jobs: JobsService,
  ) {}

  @Firewall(ADMIN)
  @Get('jobs')
  async list(@Query() query: ListJobsQueryDto): Promise<JobPageDto> {
    try {
      const page = await this.admin.listJobs(
        { status: query.status, type: query.type, shopId: query.shopId },
        { limit: query.limit, cursor: query.cursor },
      );
      return {
        items: page.items.map(toJobDto),
        ...(page.nextCursor && { nextCursor: page.nextCursor }),
      };
    } catch (error) {
      if (error instanceof InvalidCursorError)
        throw new Domain_InvalidCursorError();
      throw error;
    }
  }

  @Firewall(ADMIN)
  @Get('jobs/stats')
  async stats(): Promise<JobTypeStatsDto[]> {
    return (await this.admin.getStats()).map(toStatsDto);
  }

  /** Single job. Declared after `jobs/stats` so that the literal route wins over the parameter. */
  @Firewall(ADMIN)
  @Get('jobs/:jobId')
  async one(@Param('jobId') jobId: string): Promise<AdminJob> {
    if (!isUUID(jobId)) throw new Domain_JobNotFoundError();
    const job = await this.admin.getJob(jobId);
    if (!job) throw new Domain_JobNotFoundError();
    return {
      id: job.id,
      type: job.type,
      // The contract has no CANCELLED; a cancelled job did not run to completion.
      status: job.status === 'CANCELLED' ? 'FAILED' : job.status,
      attempts: job.attempts,
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    };
  }

  /**
   * J01 G-30: an administrator runs one of the allow-listed jobs now. The idempotency record is scoped to the calling
   * administrator; the job layer's own key (admin + key) is the second line when that record has expired.
   */
  @Firewall(ADMIN_SENSITIVE)
  @Idempotent({
    scope: (req) => `admin-jobs:${(req as { user?: { id: string } }).user?.id}`,
  })
  @Post('jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  async request(
    @Body() body: unknown,
    @User() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
  ): Promise<{ jobId: string }> {
    const parsed = createAdminJobSchema.safeParse(body);
    if (!parsed.success)
      throw new Domain_ValidationFailedError(
        parsed.error.issues.map((i) => i.path.join('.') || 'body'),
      );
    const { type, payload } = parsed.data;
    if (!(ADMIN_JOB_TYPES as readonly string[]).includes(type))
      throw new Domain_JobTypeNotAllowedError();
    try {
      const { id } = await this.jobs.enqueue(
        // allow-listed above; the job types of other domains join `JobType` only where their files are compiled
        type as JobType,
        (payload ?? {}) as never,
        { idempotencyKey: `admin-jobs:${user.id}:${key}` },
      );
      return { jobId: id };
    } catch (error) {
      if (error instanceof InvalidJobPayloadError)
        throw new Domain_InvalidJobPayloadError(error.fields);
      if (error instanceof IdempotencyKeyConflictError)
        throw new Domain_JobKeyReuseError();
      throw error;
    }
  }

  @Firewall(ADMIN_SENSITIVE)
  @Post('jobs/:id/retry')
  @HttpCode(HttpStatus.OK)
  async retry(
    @Param('id') id: string,
    @User() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!isUUID(id)) throw new Domain_JobNotFoundError();
    const result = await this.admin.retryDead(id, user.id);
    if (result.outcome === 'NOT_FOUND') throw new Domain_JobNotFoundError();
    if (result.outcome === 'CONFLICT') res.status(HttpStatus.CONFLICT);
    return result;
  }

  @Firewall(ADMIN_SENSITIVE)
  @Post('jobs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!isUUID(id)) throw new Domain_JobNotFoundError();
    const result = await this.admin.cancel(id);
    if (result.outcome === 'NOT_FOUND') throw new Domain_JobNotFoundError();
    if (result.outcome === 'CONFLICT') res.status(HttpStatus.CONFLICT);
    return result;
  }

  @Firewall(ADMIN)
  @Get('job-schedules')
  async schedules(): Promise<ScheduleDto[]> {
    return (await this.admin.listSchedules()).map(toScheduleDto);
  }

  @Firewall(ADMIN_SENSITIVE)
  @Post('job-schedules/:name/enable')
  @HttpCode(HttpStatus.OK)
  enable(@Param('name') name: string): Promise<ScheduleStateDto> {
    return this.setEnabled(name, true);
  }

  @Firewall(ADMIN_SENSITIVE)
  @Post('job-schedules/:name/disable')
  @HttpCode(HttpStatus.OK)
  disable(@Param('name') name: string): Promise<ScheduleStateDto> {
    return this.setEnabled(name, false);
  }

  private async setEnabled(
    name: string,
    enabled: boolean,
  ): Promise<ScheduleStateDto> {
    if (!(await this.admin.setScheduleEnabled(name, enabled)))
      throw new Domain_ScheduleNotFoundError();
    return { name, enabled };
  }
}

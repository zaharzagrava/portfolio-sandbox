import {
  Controller,
  Get,
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
import { InvalidCursorError, JobsAdminService } from '@app/infrastructure/jobs';
import { Firewall } from './decorators/firewall.decorator';
import { User } from './decorators/user.decorator';
import type { AuthenticatedUser } from '../domain/authenticated-user';
import {
  Domain_InvalidCursorError,
  Domain_JobNotFoundError,
  Domain_ScheduleNotFoundError,
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
  constructor(private readonly admin: JobsAdminService) {}

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

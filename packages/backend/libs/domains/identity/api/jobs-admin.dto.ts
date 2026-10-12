import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import type {
  JobDto as JobRecord,
  JobTypeStats,
  ScheduleDto as ScheduleRecord,
} from '@app/infrastructure/jobs';

const JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'DEAD',
  'CANCELLED',
] as const;

export class ListJobsQueryDto {
  @ApiPropertyOptional({ enum: JOB_STATUSES })
  @IsOptional()
  @IsIn(JOB_STATUSES)
  status?: (typeof JOB_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  shopId?: string;

  @ApiPropertyOptional({
    description: '1–100, default 50; out-of-range values are clamped',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from `nextCursor`' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

/** What an operator sees of a job. Never the payload: it may hold personal data. */
export class JobDto {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: String, nullable: true }) runAt!: string | null;
  @ApiProperty() attempts!: number;
  @ApiProperty() maxAttempts!: number;
  @ApiProperty({ type: String, nullable: true }) shopId!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastError!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) finishedAt!: string | null;
}

export class JobPageDto {
  @ApiProperty({ type: [JobDto] }) items!: JobDto[];
  @ApiPropertyOptional() nextCursor?: string;
}

export class JobTypeStatsDto {
  @ApiProperty() type!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  counts!: Record<string, number>;
  @ApiProperty({ type: String, nullable: true }) oldestDueRunAt!: string | null;
  @ApiProperty() lagSeconds!: number;
}

export class ScheduleDto {
  @ApiProperty() name!: string;
  @ApiProperty() cron!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() jobType!: string;
  @ApiProperty() enabled!: boolean;
  @ApiProperty() overlap!: string;
  @ApiProperty({ type: Number, nullable: true }) maxAttempts!: number | null;
  @ApiProperty() nextFireAt!: string;
  @ApiProperty({ type: String, nullable: true }) lastFiredAt!: string | null;
  @ApiProperty() consecutiveFailures!: number;
  @ApiProperty({ type: String, nullable: true }) lastError!: string | null;
}

export class ScheduleStateDto {
  @ApiProperty() name!: string;
  @ApiProperty() enabled!: boolean;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

export const toJobDto = (job: JobRecord): JobDto => ({
  id: job.id,
  type: job.type,
  status: job.status,
  runAt: iso(job.runAt),
  attempts: job.attempts,
  maxAttempts: job.maxAttempts,
  shopId: job.shopId,
  lastError: job.lastError,
  createdAt: iso(job.createdAt)!,
  finishedAt: iso(job.finishedAt),
});

export const toStatsDto = (stats: JobTypeStats): JobTypeStatsDto => ({
  type: stats.type,
  counts: { ...stats.counts },
  oldestDueRunAt: iso(stats.oldestDueRunAt),
  lagSeconds: stats.lagSeconds,
});

export const toScheduleDto = (s: ScheduleRecord): ScheduleDto => ({
  name: s.name,
  cron: s.cron,
  timezone: s.timezone,
  jobType: s.jobType,
  enabled: s.enabled,
  overlap: s.overlap,
  maxAttempts: s.maxAttempts,
  nextFireAt: iso(s.nextFireAt)!,
  lastFiredAt: iso(s.lastFiredAt),
  consecutiveFailures: s.consecutiveFailures,
  lastError: s.lastError,
});

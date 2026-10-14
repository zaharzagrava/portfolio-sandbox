import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ShopScoped } from '@app/domains/tenancy';
import { RequestLogService } from '../application/request-log.service';
import { UsageReportService } from '../application/usage-report.service';

const flag = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class RequestLogQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 128)
  requestId?: string;
  @ApiPropertyOptional({
    description: '2xx, 3xx, 4xx, 5xx or an exact status such as 429',
  })
  @IsOptional()
  @Matches(/^([1-5]xx|[1-5]\d\d)$/)
  status?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  route?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 64)
  keyId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(flag)
  @IsIn([true, false])
  livemode?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 512)
  cursor?: string;
}

export class UsageQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 30, default: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  days?: number;
  @ApiPropertyOptional({ description: 'false = the sandbox' })
  @IsOptional()
  @Transform(flag)
  @IsIn([true, false])
  livemode?: boolean;
  @ApiPropertyOptional({
    description: 'true = only calls to deprecated routes and versions',
  })
  @IsOptional()
  @Transform(flag)
  @IsIn([true, false])
  deprecated?: boolean;
}

/** The shop's request log and usage report (apps/core, FR-056, FR-057): thin adapters over their services. */
@ApiTags('developers')
@Controller('shops/:shopId/developers')
export class LogsUsageController {
  constructor(
    private readonly logs: RequestLogService,
    private readonly usage: UsageReportService,
  ) {}

  @ShopScoped('shop.read')
  @Get('logs')
  search(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query() q: RequestLogQuery,
  ) {
    return this.logs.search(shopId, {
      ...q,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
  }

  @ShopScoped('shop.read')
  @Get('usage')
  report(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query() q: UsageQuery,
  ) {
    return this.usage.report(shopId, {
      days: q.days ?? 7,
      livemode: q.livemode ?? true,
      deprecated: q.deprecated ?? false,
    });
  }
}

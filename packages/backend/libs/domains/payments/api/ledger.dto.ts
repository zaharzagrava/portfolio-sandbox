import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  Max,
  MinLength,
  NotEquals,
  ValidateNested,
} from 'class-validator';
import { reconciliationIssueKinds } from '@marketplace-sandbox/contracts';

/** Query of `GET /shops/:shopId/balance` (contract: `balanceSchema`); only `EUR` exists today. */
export class BalanceQueryDto {
  @ApiProperty({ required: false, enum: ['EUR'], default: 'EUR' })
  @IsOptional()
  @IsIn(['EUR'])
  currency = 'EUR' as const;
}

class PageQueryDto {
  @ApiProperty({ required: false, default: 50, minimum: 1, maximum: 200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  cursor?: string;
}

/** `GET /finance/reconciliation/runs` (contract: `reconciliationRunPageSchema`). */
export class ListRunsQueryDto extends PageQueryDto {}

/** `GET /finance/reconciliation/issues` (contract: `reconciliationIssuePageSchema`). */
export class ListIssuesQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, enum: ['OPEN', 'RESOLVED'] })
  @IsOptional()
  @IsIn(['OPEN', 'RESOLVED'])
  status?: 'OPEN' | 'RESOLVED';

  @ApiProperty({ required: false, enum: reconciliationIssueKinds })
  @IsOptional()
  @IsIn(reconciliationIssueKinds)
  kind?: (typeof reconciliationIssueKinds)[number];

  @ApiProperty({ required: false, example: '2026-10-04' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
  day?: string;
}

class AdjustmentLineDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  accountId: string;

  @ApiProperty()
  @IsInt()
  @NotEquals(0)
  amountMinor: number;
}

class AdjustmentDto {
  @ApiProperty({ enum: ['EUR'] })
  @IsIn(['EUR'])
  currency: 'EUR';

  /** Bounded here only against absurd bodies; "at most 10 lines" and "sums to zero" are `422`s of the service. */
  @ApiProperty({ type: [AdjustmentLineDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AdjustmentLineDto)
  lines: AdjustmentLineDto[];
}

/** Body of `POST …/resolve` (contract: `resolveReconciliationIssueRequestSchema`); unknown properties are a `400`. */
export class ResolveIssueDto {
  @ApiProperty({ enum: ['explained', 'adjusted'] })
  @IsIn(['explained', 'adjusted'])
  resolution: 'explained' | 'adjusted';

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  note: string;

  @ApiProperty({ required: false, type: AdjustmentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AdjustmentDto)
  adjustment?: AdjustmentDto;
}

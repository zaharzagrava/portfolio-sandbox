import { IntersectionType } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { IdField, TimestampsFields } from '@app/common/types';

/** Shape of an outbox row for seeds and tests; production code appends through `OutboxService.append*`. */
export class CreateOutboxDto {
  @ApiProperty()
  topic: string;

  @ApiProperty()
  payload: any;

  @ApiProperty()
  extra?: Record<string, any>;

  @ApiProperty()
  error?: any;

  /** Message key for per-aggregate ordering; never empty (database contract). */
  @ApiProperty()
  aggregateId?: string;
}

export class OutboxRawDto extends IntersectionType(
  IntersectionType(CreateOutboxDto, TimestampsFields),
  IdField,
) {}

export class OutboxFullDto extends OutboxRawDto {}

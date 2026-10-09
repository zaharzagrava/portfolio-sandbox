import { IntersectionType, PickType } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsUUID } from 'class-validator';
import { KafkaTopicGroup } from './outbox.model';
import { IdField, TimestampsFields } from '@app/common/types';

// --- --- --- --- --- Internal Types for Character --- --- --- --- --- //
export class CreateOutboxDto {
  @ApiProperty()
  topic: KafkaTopicGroup;

  @ApiProperty()
  payload: any;

  @ApiProperty()
  extra?: Record<string, any>;

  @ApiProperty()
  error?: any;

  /** Kafka key for per-aggregate ordering (F-05). */
  @ApiProperty()
  aggregateId?: string;
}

export class OutboxRawDto extends IntersectionType(
  IntersectionType(CreateOutboxDto, TimestampsFields),
  IdField,
) {}

export class OutboxFullDto extends OutboxRawDto {}

export interface OutboxWrapperConfig<P> {
  payload: P;
  dlqTopic: KafkaTopicGroup;
}

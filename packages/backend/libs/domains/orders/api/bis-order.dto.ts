import { ApiProperty, IntersectionType } from '@nestjs/swagger';
import {
  DeletableTimestampsFields,
  IdField,
  ImmutableTimestampsFields,
} from '@app/common/types';

// --- --- --- --- --- Internal Types for Character --- --- --- --- --- //
export class CreateBisOrderDto {
  @ApiProperty()
  userId: string;
}

export class BisOrderRawDto extends IntersectionType(
  IntersectionType(CreateBisOrderDto, DeletableTimestampsFields),
  IdField,
) {}

export class BisOrderFullDto extends BisOrderRawDto {}

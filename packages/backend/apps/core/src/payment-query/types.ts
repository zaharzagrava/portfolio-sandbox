import { HttpStatus } from '@nestjs/common';
import { IntersectionType } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus } from '@app/domains/payments';
import { DeletableTimestampsFields, IdField } from '@app/common/types';

export class CreatePaymentDto {
  @ApiProperty()
  idempotencyKey: string;

  @ApiProperty()
  amount: number;

  @ApiProperty()
  status: PaymentStatus;

  @ApiProperty()
  bisOrderId: string;
}

export class PaymentRawDto extends IntersectionType(
  IntersectionType(CreatePaymentDto, DeletableTimestampsFields),
  IdField,
) { }

export class PaymentFullDto extends PaymentRawDto { }

export class ListPaymentsResponseDto {
  @ApiProperty()
  payments: PaymentRawDto[];
}

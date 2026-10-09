import { HttpStatus } from '@nestjs/common';
import { IntersectionType, PickType } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { AppError, ConfiguredErrorParams, ErrorArea } from '@app/common/errors';
import { PaymentStatus } from '../infra/models/payment.model';
import {
  DeletableTimestampsFields,
  IdField,
  TimestampsFields,
} from '@app/common/types';

// --- --- --- --- --- Internal Types for Character --- --- --- --- --- //
export class CreatePaymentDto {
  @ApiProperty()
  idempotencyKey: string;

  @ApiProperty()
  amount: number;

  @ApiProperty()
  status: PaymentStatus;

  @ApiProperty()
  bisOrderId: string;

  @ApiProperty()
  userId: string;
}

export class PaymentRawDto extends IntersectionType(
  IntersectionType(CreatePaymentDto, DeletableTimestampsFields),
  IdField,
) {}

export class PaymentFullDto extends PaymentRawDto {}

// --- --- --- --- --- POST / --- --- --- --- --- //
export class PostPaymentParamsDto {
  @ApiProperty()
  @IsString()
  idempotency_key: string;

  @ApiProperty()
  @IsNumber()
  amount: number;

  @ApiProperty()
  @IsUUID()
  userId: string;

  @ApiProperty()
  @IsUUID()
  bisOrderId: string;

  @ApiProperty()
  @IsString()
  paymentMethodId: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  quantity?: number;
}

export class PostPaymentResponseDto {
  @ApiProperty()
  payment: PaymentRawDto;
}

// --- --- --- --- --- GET / --- --- --- --- --- //
export class ListPaymentsResponseDto {
  @ApiProperty()
  payments: PaymentRawDto[];
}

// --- --- --- --- --- Domain Errors --- --- --- --- --- //
export class Domain_StripePaymentFailed extends AppError {
  constructor(params?: ConfiguredErrorParams) {
    super({
      status: HttpStatus.BAD_REQUEST,
      detail: 'Stripe payment failed',
      title: 'Stripe payment failed',
      area: ErrorArea.DOMAIN,
      ...params,
    });
  }
}

export class Domain_InsufficientStockError extends AppError {
  constructor(params?: ConfiguredErrorParams) {
    super({
      status: HttpStatus.CONFLICT,
      detail: 'Not enough stock for this purchase',
      title: 'Insufficient stock',
      area: ErrorArea.DOMAIN,
      ...params,
    });
  }
}

import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PAYMENT_STATUSES } from '@marketplace-sandbox/contracts';
import { PaymentStatus } from '../infra/models/payment.model';

/** Query of `GET /payments` (contract: `paymentListQuerySchema`). */
export class ListPaymentsQueryDto {
  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiProperty({ required: false, enum: PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  status?: (typeof PAYMENT_STATUSES)[number];

  @ApiProperty({ required: false, default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  cursor?: string;
}

/**
 * Row shape the test seeds build `Payment` rows from (kept until the seeds use `@app/domains/payments/testing`, S13
 * T067). Not a request body of any route.
 */
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

/**
 * Body of `POST /payments/intents` (contract: `createPaymentIntentRequestSchema`). Unknown properties (`amountMinor`,
 * `currency`, `userId`, card fields ...) are rejected globally and named in the `400`.
 */
export class CreatePaymentIntentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  orderId: string;

  @ApiProperty({ description: 'The provider token of the payment method' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  paymentMethodId: string;
}

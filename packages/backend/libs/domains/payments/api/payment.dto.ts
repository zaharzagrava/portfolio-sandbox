import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PaymentStatus } from '../infra/models/payment.model';

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

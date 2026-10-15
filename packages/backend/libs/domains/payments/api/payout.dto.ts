import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { payoutStatusesInternal } from '@marketplace-sandbox/contracts';

/** Paging query shared by the payout lists (contracts: `payoutPageSchema`, `adminPayoutPageSchema`, `payoutRunPageSchema`). */
export class PayoutPageQueryDto {
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

/** `GET /finance/payouts`. */
export class AdminPayoutQueryDto extends PayoutPageQueryDto {
  @ApiProperty({ required: false, enum: payoutStatusesInternal })
  @IsOptional()
  @IsIn(payoutStatusesInternal)
  status?: (typeof payoutStatusesInternal)[number];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  shopId?: string;

  @ApiProperty({ required: false, example: '2026-10-05' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
  periodStart?: string;
}

/** `PUT /finance/shops/:shopId/payout-destination`: the account format is a `422` of the service, not a `400`. */
export class SetDestinationDto {
  @ApiProperty({ example: 'acct_1AbCdEfGh' })
  @IsString()
  @MaxLength(255)
  providerAccountId: string;
}

/** `PUT /finance/shops/:shopId/payout-reserve`. */
export class SetReserveDto {
  @ApiProperty({ minimum: 0, maximum: 5000 })
  @IsInt()
  @Min(0)
  @Max(5000)
  reserveBps: number;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason: string;
}

/** `POST /finance/payouts/:payoutId/cancel`. */
export class CancelPayoutDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason: string;
}

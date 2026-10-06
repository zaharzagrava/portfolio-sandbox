import { ApiProperty, IntersectionType } from "@nestjs/swagger";
import { IdField, ImmutableTimestampsFields } from "@app/common/types";

// --- --- --- --- --- Internal Types for Character --- --- --- --- --- //
export class CreateLedgerEntryDto {
  @ApiProperty()
  accountId: LedgerAccountId;

  @ApiProperty()
  paymentId: string;

  @ApiProperty()
  amount: number;
}

export class LedgerEntryRawDto extends IntersectionType(
  IntersectionType(CreateLedgerEntryDto, ImmutableTimestampsFields),
  IdField,
) { }

export class LedgerEntryFullDto extends LedgerEntryRawDto { }

// ---

export enum SystemAccount {
  FBO_INBOUND_ESCROW = 'SYS_FBO_INBOUND_ESCROW',
  PLATFORM_FEES = 'SYS_PLATFORM_FEES',
}

// A helper type to ensure type safety across your app
export type LedgerAccountId = SystemAccount | `MERCHANT_${string}` | `USER_${string}`;

// For this demo, we use a fixed fee amount of $1
export const FEE_AMOUNT = 100;

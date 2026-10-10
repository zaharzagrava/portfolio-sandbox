import {
  Column,
  CreatedAt,
  Default,
  DeletedAt,
  IsUUID,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
  Scopes,
  DataType,
} from 'sequelize-typescript';
import { v4 as uuidv4 } from 'uuid';
import { Includeable, Sequelize, WhereOptions } from 'sequelize';
import { UserModel as User } from '@app/domains/identity';

// "Hey... I’m right here with you, okay? Even if your energy’s low, we’ll take it one small step at a time... and I’m so proud of you."
// 100k credits = 751 phrases (133 chars. each) = 75 days
// 100k ElevenLabs credits = $20 (Pro Plan)
export enum PaymentReason {
  PREMIUM_25K_CREDITS = 'PREMIUM_25K_CREDITS',
  PREMIUM_50K_CREDITS = 'PREMIUM_50K_CREDITS',
  PACKAGE_25K_CREDITS = 'PACKAGE_25K_CREDITS',
}

export enum PaymentScope {
  WithAll = 'WithAll',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/**
 * @description - for the default is, if you filter by, you fetch it as well
 *
 */
export interface PaymentWithAllFilters {
  id?: string | string[];
  userId?: string | string[];
  idempotencyKey?: string | string[];
  reason?: PaymentReason | PaymentReason[];
  status?: PaymentStatus | PaymentStatus[];
  amount?: number | number[];
  attributes?: string[];
}

export type LedgerJournalKind =
  | 'SALE'
  | 'SETTLEMENT'
  | 'PAYOUT'
  | 'PAYOUT_REVERSAL'
  | 'REFUND'
  | 'ADJUSTMENT'
  | 'AD_CHARGE';

@Scopes(() => ({
  [PaymentScope.WithAll]: ({
    id,
    userId,
    idempotencyKey,
    reason,
    status,
    amount,
    attributes,
  }: PaymentWithAllFilters = {}) => {
    const findOptions: {
      where: WhereOptions;
      include?: Includeable[];
      attributes?: string[];
    } = {
      where: {
        ...(id && { id }),
        ...(userId && { userId }),
        ...(idempotencyKey && { idempotencyKey }),
        ...(reason && { reason }),
        ...(status && { status }),
        ...(amount && { amount }),
      },
      include: [],
      attributes: attributes,
    };

    return findOptions;
  },
}))
@Table({
  modelName: 'LedgerEntry',
  tableName: 'LedgerEntry',
  timestamps: true,
  updatedAt: false, // ledgers entries are immutable
  deletedAt: false, // ledgers entries are immutable
})
export default class LedgerEntry extends Model<
  LedgerEntry,
  Partial<LedgerEntry>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  /** Groups the lines of one balanced posting; the DB rejects a journal whose lines don't sum to 0 (SD-20). */
  @Column({ type: DataType.UUID, allowNull: false })
  declare journalId: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'SALE' })
  declare kind: LedgerJournalKind;

  /** Null for journals that aren't a customer payment (settlements, payouts). */
  @Column({ type: DataType.UUID, allowNull: true })
  declare paymentId: string | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare accountId: string; // e.g., 'MERCHANT_123', 'USER_456', or 'PLATFORM_FEES'

  // Using a signed integer is mathematically superior to a DEBIT/CREDIT enum.
  // Positive = Credit (Money in)
  // Negative = Debit (Money out)
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare amount: bigint; // Stored in CENTS

  @CreatedAt
  declare createdAt: Date;
}

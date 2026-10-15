import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';
import type { PayoutStatus } from '../../domain/payout-state';

export type { PayoutStatus } from '../../domain/payout-state';

/**
 * The payout aggregate (S15 data-model.md). `shopId` is a plain id (no foreign key, IX.4). `amount` and
 * `providerRef` are the legacy names of `amountMinor` and `transferRef`, kept equal by the database until the contract
 * release. BIGINT columns arrive as strings: the repository converts them with `safeNumber`.
 */
@Table({ modelName: 'Payout', tableName: 'Payout', timestamps: true })
export default class Payout extends Model<Payout, Partial<Payout>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  /** One payout per shop per period: UNIQUE(shopId, periodStart) makes the weekly run idempotent. */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare periodStart: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'EUR' })
  declare currency: string;

  /** Legacy name of `amountMinor`. */
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare amount: string | number;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare amountMinor: string | number | null;

  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare reserveHeldMinor: string | number;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'PENDING' })
  declare status: PayoutStatus;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare destinationSnapshot: string | null;

  /** Legacy name of `transferRef`. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare providerRef: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare transferRef: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare failureCode: string | null;

  /** Sanitized, at most 200 characters (enforced in the application; legacy rows keep their text). */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare failureReason: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare attempts: number;

  @Column({ type: DataType.SMALLINT, allowNull: false, defaultValue: 0 })
  declare resendCount: number;

  @Column({ type: DataType.SMALLINT, allowNull: false, defaultValue: 0 })
  declare lookupFailures: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare nextResolveAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare inDoubtSince: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare inDoubtEventAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare discrepancyReportedAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare payoutVersion: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare submittedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare paidAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare cancelledAt: Date | null;

  declare createdAt: Date;
  declare updatedAt: Date;
}

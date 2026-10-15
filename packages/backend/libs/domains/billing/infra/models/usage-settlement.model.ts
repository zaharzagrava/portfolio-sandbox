import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/**
 * The settlement ledger of S18 (data-model.md): what was billed for the usage of `(subscription, period, metric)`.
 * Settled values only move forward (store trigger `usage_settlement_forward_only`). Registered so the model registry
 * knows the table; the billing code reads and writes it with SQL (`usage-settlement.repository.ts`).
 */
@Table({
  modelName: 'UsageSettlement',
  tableName: 'UsageSettlement',
  timestamps: true,
})
export default class UsageSettlement extends Model<
  UsageSettlement,
  Partial<UsageSettlement>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4 })
  declare id: string;
  @Column({ type: DataType.UUID, allowNull: false })
  declare subscriptionId: string;
  @Column({ type: DataType.DATE, allowNull: false })
  declare periodStart: Date;
  @Column({ type: DataType.DATE, allowNull: false })
  declare periodEnd: Date;
  @Column({ type: DataType.TEXT, allowNull: false })
  declare metric: string;
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare settledQuantity: string;
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare settledAmountMinor: string;
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare includedQuantity: string;
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare overagePer1000Minor: string;
  @Column({ type: DataType.UUID, allowNull: false })
  declare lastInvoiceId: string;
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare closed: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;
}

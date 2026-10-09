import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

export type PayoutStatus = 'PENDING' | 'PAID' | 'FAILED';

@Table({ modelName: 'Payout', tableName: 'Payout', timestamps: true })
export default class Payout extends Model<Payout, Partial<Payout>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare amount: number;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'EUR' })
  declare currency: string;

  /** One payout per shop per period: UNIQUE(shopId, periodStart) makes the weekly run idempotent. */
  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare periodStart: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'PENDING' })
  declare status: PayoutStatus;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare providerRef: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare failureReason: string | null;

  declare createdAt: Date;
  declare updatedAt: Date;
}

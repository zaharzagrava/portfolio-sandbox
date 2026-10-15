import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** One row per payout transition, append-only (S15 data-model.md). `actor` is `system`, `migration` or an admin id. */
@Table({
  modelName: 'PayoutHistory',
  tableName: 'PayoutHistory',
  timestamps: false,
})
export default class PayoutHistory extends Model<
  PayoutHistory,
  Partial<PayoutHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare payoutId: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare fromStatus: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare toStatus: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare payoutVersion: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare actor: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;
}

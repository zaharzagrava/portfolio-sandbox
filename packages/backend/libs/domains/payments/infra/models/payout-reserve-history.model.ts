import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Append-only: one row per effective reserve change, with the previous value. */
@Table({
  modelName: 'PayoutReserveHistory',
  tableName: 'PayoutReserveHistory',
  timestamps: false,
})
export default class PayoutReserveHistory extends Model<
  PayoutReserveHistory,
  Partial<PayoutReserveHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.SMALLINT, allowNull: true })
  declare previousBps: number | null;

  @Column({ type: DataType.SMALLINT, allowNull: false })
  declare reserveBps: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare reason: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare actor: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;
}

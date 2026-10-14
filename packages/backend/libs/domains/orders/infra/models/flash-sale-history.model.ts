import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Append-only record of a sale's status changes, written in the transition's transaction (S11 data-model §1). */
@Table({
  modelName: 'FlashSaleHistory',
  tableName: 'FlashSaleHistory',
  timestamps: false,
})
export default class FlashSaleHistory extends Model<
  FlashSaleHistory,
  Partial<FlashSaleHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare saleId: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare fromStatus: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare toStatus: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare actor: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;
}

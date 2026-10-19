import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/**
 * A booking voucher (J03 G-04, S10): issued once per confirmed hold, from the `orders.booking_voucher_requested` command.
 * `holdId` is UNIQUE (the redelivery guard); `launchEventId` and `shopId` are plain ids, no foreign key (IX.4).
 */
@Table({
  modelName: 'Voucher',
  tableName: 'Voucher',
  timestamps: false,
})
export default class Voucher extends Model<Voucher, Partial<Voucher>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false, unique: true })
  declare holdId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare launchEventId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare userId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare seatCount: number;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'ISSUED' })
  declare status: 'ISSUED';

  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;
}

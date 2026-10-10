import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** The order copy (R3), one row per order, fed by `orders.events` through a version-guarded upsert. */
@Table({
  modelName: 'PayableOrder',
  tableName: 'PayableOrder',
  timestamps: false,
})
export default class PayableOrder extends Model<
  PayableOrder,
  Partial<PayableOrder>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare orderId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare userId: string;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare totalMinor: number | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare currency: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare status: 'RESERVED' | 'PAID' | 'CANCELLED';

  @Column({ type: DataType.DATE, allowNull: true })
  declare reservedUntil: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare orderVersion: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}

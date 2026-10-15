import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Where a shop's payouts go; the full value is stored once and masked everywhere else. `shopId` is a plain id. */
@Table({
  modelName: 'PayoutDestination',
  tableName: 'PayoutDestination',
  timestamps: false,
})
export default class PayoutDestination extends Model<
  PayoutDestination,
  Partial<PayoutDestination>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare providerAccountId: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare effectiveFrom: Date;

  @Column({ type: DataType.DATE, allowNull: false })
  declare changedAt: Date;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare changedBy: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;
}

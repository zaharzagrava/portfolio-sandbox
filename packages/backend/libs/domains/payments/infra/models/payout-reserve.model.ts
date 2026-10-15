import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** A shop's reserve override in basis points; an absent row means the platform default. */
@Table({
  modelName: 'PayoutReserve',
  tableName: 'PayoutReserve',
  timestamps: false,
})
export default class PayoutReserve extends Model<
  PayoutReserve,
  Partial<PayoutReserve>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare shopId: string;

  @Column({ type: DataType.SMALLINT, allowNull: false })
  declare reserveBps: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare reason: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare updatedBy: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}

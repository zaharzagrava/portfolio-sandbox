import {
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  BelongsTo,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';
import BisOrder from './bis-order.model';

@Table({
  modelName: 'BisOrderItem',
  timestamps: true,
  tableName: 'BisOrderItem',
})
export default class BisOrderItem extends Model<
  BisOrderItem,
  Partial<BisOrderItem>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @ForeignKey(() => BisOrder)
  @Column({ type: DataType.UUID, allowNull: false })
  declare bisOrderId: string;

  @BelongsTo(() => BisOrder, { foreignKey: 'bisOrderId' })
  declare bisOrder: BisOrder;

  /** Plain id of the catalog's product: no association to a foreign model (IX.4). */
  @Column({ type: DataType.UUID, allowNull: false })
  declare productId: string;

  /** The product title at purchase time (NULL until the backfill job has filled legacy rows). */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare title: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare quantity: number;

  /** The unit price at purchase time (API: `unitPriceMinor`). */
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare priceAtPurchase: number;

  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare discountMinor: number;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare lineTotalMinor: number | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare shopId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare flashSaleId: string | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}

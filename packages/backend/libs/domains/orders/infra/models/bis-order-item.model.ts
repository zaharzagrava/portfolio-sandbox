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
import { ProductModel as Product } from '@app/domains/catalog';

@Table({
  modelName: 'BisOrderItem',
  timestamps: true,
  tableName: 'BisOrderItem',
})
export default class BisOrderItem extends Model<BisOrderItem, Partial<BisOrderItem>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @ForeignKey(() => BisOrder)
  @Column({ type: DataType.UUID, allowNull: false })
  declare bisOrderId: string;

  @BelongsTo(() => BisOrder, { foreignKey: 'bisOrderId' })
  declare bisOrder: BisOrder;

  @ForeignKey(() => Product)
  @Column({ type: DataType.UUID, allowNull: false })
  declare productId: string;

  @BelongsTo(() => Product, { foreignKey: 'productId' })
  declare product: Product;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare quantity: number;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare priceAtPurchase: number;

  @Column({ type: DataType.UUID, allowNull: true })
  declare shopId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare flashSaleId: string | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}

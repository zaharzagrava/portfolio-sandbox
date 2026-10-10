import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** One applied stock operation; `operationId` is the caller's idempotency key. Purged after 30 days. */
@Table({
  modelName: 'ProductStockOperation',
  tableName: 'ProductStockOperation',
  timestamps: false,
})
export default class ProductStockOperation extends Model<
  ProductStockOperation,
  Partial<ProductStockOperation>
> {
  @PrimaryKey
  @Column({ type: DataType.STRING(128) })
  declare operationId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare productId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare delta: number;

  @Column({ type: DataType.STRING(64), allowNull: false })
  declare reason: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare quantityAfter: number;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare productVersion: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare appliedAt: Date;
}

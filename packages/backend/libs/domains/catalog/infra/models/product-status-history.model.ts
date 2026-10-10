import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Append-only record of every product status change (III.7); deleted with the product by the shop purge. */
@Table({
  modelName: 'ProductStatusHistory',
  tableName: 'ProductStatusHistory',
  timestamps: false,
})
export default class ProductStatusHistory extends Model<
  ProductStatusHistory,
  Partial<ProductStatusHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare productId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.STRING(16), allowNull: false })
  declare fromStatus: string;

  @Column({ type: DataType.STRING(16), allowNull: false })
  declare toStatus: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare productVersion: number;

  @Column({ type: DataType.UUID, allowNull: true })
  declare actorId: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;
}

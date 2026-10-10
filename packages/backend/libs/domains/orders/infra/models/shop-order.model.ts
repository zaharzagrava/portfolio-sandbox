import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

@Table({ modelName: 'ShopOrder', tableName: 'ShopOrder', timestamps: true })
export default class ShopOrder extends Model<ShopOrder, Partial<ShopOrder>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare bisOrderId: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare shopId: string | null;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare subtotal: number;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'PENDING' })
  declare status: 'PENDING' | 'PAID' | 'CANCELLED' | 'REFUNDED';

  declare createdAt: Date;
  declare updatedAt: Date;
}

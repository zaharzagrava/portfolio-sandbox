import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** The catalog's copy of the shop facts it needs (IX.8). No row means the shop is `ACTIVE`. */
@Table({
  modelName: 'ProductShopState',
  tableName: 'ProductShopState',
  timestamps: false,
})
export default class ProductShopState extends Model<
  ProductShopState,
  Partial<ProductShopState>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare shopId: string;

  @Column({ type: DataType.STRING(16), allowNull: false })
  declare status: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare shopVersion: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}

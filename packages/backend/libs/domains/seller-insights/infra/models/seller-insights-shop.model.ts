import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Shop name and slug as this capability last heard them (R3 read model, S40 FR-014); version-guarded, erased on shop deletion. */
@Table({
  modelName: 'SellerInsightsShop',
  tableName: 'SellerInsightsShop',
  timestamps: true,
  createdAt: false,
})
export default class SellerInsightsShop extends Model<
  SellerInsightsShop,
  Partial<SellerInsightsShop>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare slug: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare shopVersion: number;

  declare updatedAt: Date;
}

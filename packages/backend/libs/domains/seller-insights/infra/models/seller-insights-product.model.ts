import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Product category as this capability last heard it (R3 read model, S40 FR-008); version-guarded, kept after the product is deleted. */
@Table({
  modelName: 'SellerInsightsProduct',
  tableName: 'SellerInsightsProduct',
  timestamps: true,
  createdAt: false,
})
export default class SellerInsightsProduct extends Model<
  SellerInsightsProduct,
  Partial<SellerInsightsProduct>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare productId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare category: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare productVersion: number;

  declare updatedAt: Date;
}

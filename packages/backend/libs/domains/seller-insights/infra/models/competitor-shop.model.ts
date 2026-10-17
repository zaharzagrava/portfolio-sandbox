import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Plan and status of a shop as tenancy events last said (R3 read model, S41 FR-029); version-guarded. */
@Table({
  modelName: 'CompetitorShop',
  tableName: 'CompetitorShop',
  timestamps: true,
  createdAt: false,
})
export default class CompetitorShop extends Model<
  CompetitorShop,
  Partial<CompetitorShop>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare plan: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare status: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  declare updatedAt: Date;
}

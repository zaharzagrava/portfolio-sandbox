import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Tenant → cell (pooled vs dedicated database) and region. */
@Table({
  modelName: 'ShopDirectory',
  tableName: 'ShopDirectory',
  timestamps: true,
  createdAt: false,
})
export default class ShopDirectory extends Model<
  ShopDirectory,
  Partial<ShopDirectory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'pooled' })
  declare cell: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    defaultValue: 'eu-central-1',
  })
  declare region: string;

  declare updatedAt: Date;
}

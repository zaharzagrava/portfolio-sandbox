import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Tenant → cell (pooled vs dedicated database) and region. Routing data, read before a tenant is known: no RLS. */
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

  /** Conditional update target for the admin move. */
  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 1 })
  declare version: string | number;

  declare updatedAt: Date;
}

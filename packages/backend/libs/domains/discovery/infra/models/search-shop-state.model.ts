import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Copy of the tenancy facts search needs (status, plan), fed by `shop.events` (IX.8). A missing row means ACTIVE. */
@Table({
  modelName: 'SearchShopState',
  tableName: 'SearchShopState',
  timestamps: false,
})
export default class SearchShopState extends Model<
  SearchShopState,
  Partial<SearchShopState>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare status: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';

  @Column({ type: DataType.TEXT, allowNull: true })
  declare plan: 'STARTER' | 'PRO' | 'ENTERPRISE' | null;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare shopVersion: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare offboarding: boolean;

  @Column({ type: DataType.DATE, allowNull: false })
  declare lastEventAt: Date;
}

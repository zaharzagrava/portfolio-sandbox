import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import type { MemberSource, ShopRole } from '../../domain/shop-types';

export type { ShopRole };

/** RLS-protected: visible by shop context, or by the owning user for reads. `userId` is a plain id (no FK to identity). */
@Table({
  modelName: 'ShopMembership',
  tableName: 'ShopMembership',
  timestamps: true,
  updatedAt: false,
})
export default class ShopMembership extends Model<
  ShopMembership,
  Partial<ShopMembership>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare shopId: string;

  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare userId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare role: ShopRole;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    defaultValue: 'provisioned',
  })
  declare source: MemberSource;

  declare createdAt: Date;
}

import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';
import { Sequelize } from 'sequelize';
import { ShopRole } from './shop-membership.model';

/** RLS-protected (tenant_isolation policy): only readable inside a transaction scoped to its shop. */
@Table({ modelName: 'ShopInvite', tableName: 'ShopInvite', timestamps: true, updatedAt: false })
export default class ShopInvite extends Model<ShopInvite, Partial<ShopInvite>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare email: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare role: Exclude<ShopRole, 'OWNER'>;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare tokenHash: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare invitedBy: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare acceptedAt: Date | null;

  declare createdAt: Date;
}

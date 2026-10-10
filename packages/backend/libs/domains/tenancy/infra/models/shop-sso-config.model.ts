import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Per-shop enterprise IdP (OIDC). RLS-protected; client secret encrypted (SecretBox). */
@Table({
  modelName: 'ShopSsoConfig',
  tableName: 'ShopSsoConfig',
  timestamps: true,
  createdAt: false,
})
export default class ShopSsoConfig extends Model<
  ShopSsoConfig,
  Partial<ShopSsoConfig>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare issuer: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare clientId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare clientSecretEnc: string;

  /** Role given to a member provisioned by a login through this provider. */
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'VIEWER' })
  declare defaultRole: 'STAFF' | 'VIEWER';

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare enabled: boolean;

  declare updatedAt: Date;
}

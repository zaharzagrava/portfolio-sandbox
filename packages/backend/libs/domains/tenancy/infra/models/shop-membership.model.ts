import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';

export type ShopRole = 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER';

@Table({ modelName: 'ShopMembership', tableName: 'ShopMembership', timestamps: true, updatedAt: false })
export default class ShopMembership extends Model<ShopMembership, Partial<ShopMembership>> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare shopId: string;

  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare userId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare role: ShopRole;

  declare createdAt: Date;
}

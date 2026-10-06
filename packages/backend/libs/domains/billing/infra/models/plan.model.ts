import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

export interface Entitlements {
  freeShipping?: boolean;
  earlyAccessDrops?: boolean;
  maxProducts?: number;
  seats?: number;
  auctions?: boolean;
  apiCallsPerMonth?: number;
  assistantTokensPerMonth?: number;
}

@Table({ modelName: 'Plan', tableName: 'Plan', timestamps: true, updatedAt: false })
export default class Plan extends Model<Plan, Partial<Plan>> {
  @PrimaryKey @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') }) declare id: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare code: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare name: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare audience: 'BUYER' | 'SHOP';
  @Column({ type: DataType.JSONB, allowNull: false }) declare entitlements: Entitlements;
  declare createdAt: Date;
}

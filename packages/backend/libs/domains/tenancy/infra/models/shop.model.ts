import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

export type ShopPlan = 'STARTER' | 'PRO' | 'ENTERPRISE';
export type ShopStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETING';
export type ShopVerificationStatus =
  'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED';

/** A tenant (SD-02): the seller organisation that owns products, staff, API keys, webhooks, payouts. */
@Table({ modelName: 'Shop', tableName: 'Shop', timestamps: true })
export default class Shop extends Model<Shop, Partial<Shop>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.TEXT, allowNull: false, unique: true })
  declare slug: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'STARTER' })
  declare plan: ShopPlan;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'ACTIVE' })
  declare status: ShopStatus;

  /** Stripe Connect account receiving payouts (SD-20). */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare stripeAccountId: string | null;

  /** SD-44 KYC outcome; payouts stay disabled until VERIFIED. */
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'UNVERIFIED' })
  declare verificationStatus: ShopVerificationStatus;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare payoutsEnabled: boolean;

  declare createdAt: Date;
  declare updatedAt: Date;
}

import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';
import type { ShopPlan } from '../../domain/shop-types';
import type { ShopStatus } from '../../domain/shop-status';
import type { VerificationStatus } from '../../domain/verification-status';

export type { ShopPlan, ShopStatus };
export type ShopVerificationStatus = VerificationStatus;

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

  /** Last applied `billing.subscription_plan_changed` version (out-of-order guard). */
  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare planVersion: string | number;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'ACTIVE' })
  declare status: ShopStatus;

  @Column({ type: DataType.DATE, allowNull: true })
  declare purgeAt: Date | null;

  /** Entity version: +1 on every write, carried by events (IX.8). */
  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 1 })
  declare shopVersion: string | number;

  /** Stripe Connect account receiving payouts (SD-20). Not exposed by any tenancy DTO; S14/S15 take it over. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare stripeAccountId: string | null;

  /** SD-44 KYC outcome; payouts stay disabled until VERIFIED. */
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'UNVERIFIED' })
  declare verificationStatus: ShopVerificationStatus;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare payoutsEnabled: boolean;

  /** Set on a sandbox shop: the live shop it mirrors. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare sandboxOf: string | null;

  declare createdAt: Date;
  declare updatedAt: Date;
}

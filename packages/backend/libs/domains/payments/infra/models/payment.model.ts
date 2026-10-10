import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Scopes,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Sequelize, WhereOptions } from 'sequelize';

export enum PaymentScope {
  WithAll = 'WithAll',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
  /** Provider call timed out: the charge may or may not exist. Resolved by asking the provider (SD-20), never by re-sending blindly. */
  UNKNOWN = 'UNKNOWN',
  /** A refund was requested and is being executed at the provider. */
  REFUND_PENDING = 'REFUND_PENDING',
}

export interface PaymentWithAllFilters {
  id?: string | string[];
  userId?: string;
  idempotencyKey?: string | string[];
  status?: PaymentStatus | PaymentStatus[];
  amount?: number | number[];
  attributes?: string[];
}

@Scopes(() => ({
  [PaymentScope.WithAll]: ({
    id,
    userId,
    idempotencyKey,
    status,
    amount,
    attributes,
  }: PaymentWithAllFilters = {}) => {
    const findOptions: {
      where: WhereOptions;
      attributes?: string[];
    } = {
      where: {
        ...(id && { id }),
        ...(userId && { userId }),
        ...(idempotencyKey && { idempotencyKey }),
        ...(status && { status }),
        ...(amount && { amount }),
      },
      attributes: attributes,
    };
    return findOptions;
  },
}))
@Table({
  modelName: 'Payment',
  timestamps: true,
  tableName: 'Payment',
})
export default class Payment extends Model<Payment, Partial<Payment>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  /** Legacy (client-chosen key); never read by S13, NULL on new rows, dropped at the contract release. */
  @Column({ type: DataType.STRING, allowNull: true })
  declare idempotencyKey: string;

  @Column({ type: DataType.BIGINT })
  declare amount: number;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'USD' })
  declare currency: string;

  @Column({ type: DataType.ENUM(...Object.values(PaymentStatus)) })
  declare status: PaymentStatus;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;

  /** Plain column: no association to the user (IX.4). */
  @Column({ type: DataType.STRING, allowNull: false })
  declare userId: string;

  /** Legacy copy of `orderId`, still written until the contract release; no association, no foreign key. */
  @Column({ type: DataType.UUID, allowNull: false })
  declare bisOrderId: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare orderId: string | null;

  /** Provider reference (Stripe PaymentIntent id) once known. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare providerRef: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare chargeAttemptedAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare chargeAttempts: number;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare requiresAction: boolean;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare clientSecret: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare paymentMethodToken: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare failureCode: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare nextResolveAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare resolveChecks: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare unknownSince: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastStuckAlertAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare refundRequestedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare refundNextAt: Date | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}

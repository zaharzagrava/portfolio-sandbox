import {
  Column,
  CreatedAt,
  Default,
  DeletedAt,
  IsUUID,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
  Scopes,
  DataType,
  BelongsTo,
  HasMany,
  ForeignKey,
} from 'sequelize-typescript';
import { Includeable, Sequelize, WhereOptions } from 'sequelize';
import type {
  BisOrderModel as BisOrder,
  BisOrderWithAllFilters,
} from '@app/domains/orders';
import LedgerEntry from './ledger-entry.model';

/**
 * orders ↔ payments associate each other's models (debt D-11). A top-level import of the orders barrel would
 * load orders' Nest modules while this barrel is still mid-load, leaving `@InjectModel(Payment)` undefined in
 * apps that load payments first (payment-processor). Every use below is lazy, so resolve orders on demand.
 */

const orders = (): typeof import('@app/domains/orders') =>
  require('@app/domains/orders');

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
}

/**
 * @description - for the default is, if you filter by, you fetch it as well
 *
 */
export interface PaymentWithAllFilters {
  id?: string | string[];
  idempotencyKey?: string | string[];
  status?: PaymentStatus | PaymentStatus[];
  amount?: number | number[];
  attributes?: string[];

  // BisOrder filters
  bisOrderFilters?: BisOrderWithAllFilters;
  bisOrderRequired?: boolean;
}

@Scopes(() => ({
  [PaymentScope.WithAll]: ({
    id,
    idempotencyKey,
    status,
    amount,
    attributes,
    bisOrderFilters,
    bisOrderRequired,
  }: PaymentWithAllFilters = {}) => {
    const findOptions: {
      where: WhereOptions;
      include?: Includeable[];
      attributes?: string[];
    } = {
      where: {
        ...(id && { id }),
        ...(idempotencyKey && { idempotencyKey }),
        ...(status && { status }),
        ...(amount && { amount }),
      },
      include: [],
      attributes: attributes,
    };

    if (bisOrderFilters) {
      findOptions.include?.push({
        model: orders().BisOrderModel.scope({
          method: [orders().BisOrderScope.WithAll, bisOrderFilters],
        }),
        as: 'bisOrder',
        required: bisOrderRequired ?? false,
      });
    }

    return findOptions;
  },
}))
@Table({
  modelName: 'Payment',
  timestamps: true,
  tableName: 'Payment',
  indexes: [
    {
      name: 'idx_payment_user_id_desc',
      fields: ['userId', { name: 'id', order: 'DESC' }],
    },
  ],
})
export default class Payment extends Model<Payment, Partial<Payment>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.STRING })
  declare idempotencyKey: string;

  @Column({ type: DataType.BIGINT })
  declare amount: number;

  @Column({ type: DataType.ENUM(...Object.values(PaymentStatus)) })
  declare status: PaymentStatus;

  @Column({ type: DataType.STRING, allowNull: false })
  declare userId: string;

  @ForeignKey(() => orders().BisOrderModel)
  @Column({ type: DataType.STRING, allowNull: false })
  declare bisOrderId: string;

  /** Provider reference (Stripe PaymentIntent id) once known. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare providerRef: string | null;

  @BelongsTo(() => orders().BisOrderModel, { foreignKey: 'bisOrderId' })
  declare bisOrder: BisOrder;

  @HasMany(() => LedgerEntry, { foreignKey: 'paymentId' })
  declare ledgerEntries: LedgerEntry[];

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}

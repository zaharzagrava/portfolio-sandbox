import {
  Column,
  CreatedAt,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
  Scopes,
  DataType,
} from 'sequelize-typescript';
import { Includeable, Sequelize, WhereOptions } from 'sequelize';
import type { CancelReason, OrderStatus } from '../../domain/order-state';

export enum BisOrderScope {
  WithAll = 'WithAll',
}

/**
 * @description - for the default is, if you filter by, you fetch it as well
 *
 */
export interface BisOrderWithAllFilters {
  id?: string | string[];
  userId?: string | string[];
  attributes?: string[];
}

@Scopes(() => ({
  [BisOrderScope.WithAll]: ({
    id,
    userId,
    attributes,
  }: BisOrderWithAllFilters = {}) => {
    const findOptions: {
      where: WhereOptions;
      include?: Includeable[];
      attributes?: string[];
    } = {
      where: {
        ...(id && { id }),
        ...(userId && { userId }),
      },
      include: [],
      attributes: attributes,
    };

    return findOptions;
  },
}))
@Table({
  modelName: 'BisOrder',
  timestamps: true,
  tableName: 'BisOrder',
})
export default class BisOrder extends Model<BisOrder, Partial<BisOrder>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  /** Plain id of the buyer (identity's user): no association to a foreign model (IX.4). */
  @Column({ type: DataType.STRING })
  declare userId: string;

  /** State machine - see libs/domains/orders/domain/order-state.ts. */
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'PENDING' })
  declare status: OrderStatus;

  /** Server-computed (never from the client), minor units. */
  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare total: number;

  /**
   * Checkout always writes the currency of the products. The model default exists only for the auctions worker, which
   * still creates orders through this model (S21 replaces it with an order-creating command).
   */
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'EUR' })
  declare currency: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare idempotencyKey: string | null;

  /** SHA-256 of the canonical checkout body; `NULL` for legacy orders. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare requestHash: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare reservedUntil: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare cancelReason: CancelReason | null;

  /** The payment provider's reference, set by the move to `PAID`. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare paymentRef: string | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}

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
} from 'sequelize-typescript';
import { v4 as uuidv4 } from 'uuid';
import { Includeable, Sequelize, WhereOptions } from 'sequelize';
import { UserModel as User } from '@app/domains/identity';
import type { PaymentModel as Payment } from '@app/domains/payments';

/** orders ↔ payments associate each other's models (debt D-11); resolve payments lazily (see payment.model.ts). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const payments = (): typeof import('@app/domains/payments') =>
  require('@app/domains/payments');
import BisOrderItem from './bis-order-item.model';
import type { OrderStatus } from '../../domain/order-state';

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

  @Column({ type: DataType.STRING })
  declare userId: string;

  @BelongsTo(() => User, { foreignKey: 'userId' })
  declare user: User;

  @HasMany(() => payments().PaymentModel, { foreignKey: 'bisOrderId' })
  declare payments: Payment[];

  @HasMany(() => BisOrderItem, { foreignKey: 'bisOrderId' })
  declare items: BisOrderItem[];

  /** SD-19 state machine - see libs/domains/orders/domain/order-state.ts. */
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'PENDING' })
  declare status: OrderStatus;

  /** Server-computed (never from the client), minor units. */
  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare total: number;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'EUR' })
  declare currency: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare idempotencyKey: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare reservedUntil: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare version: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare cancelReason: string | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}

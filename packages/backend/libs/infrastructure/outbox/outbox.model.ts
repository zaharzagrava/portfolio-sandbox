import {
  Column,
  CreatedAt,
  DataType,
  DeletedAt,
  Model,
  PrimaryKey,
  Scopes,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Includeable, Sequelize, WhereOptions } from 'sequelize';

export enum KafkaTopicGroup {
  PAYMENTS_REQUESTS = 'payments.requests',
  PAYMENTS_RESPONSES = 'payments.responses',
  PAYMENTS_DLQ = 'payments.dlq',
  PRODUCTS_EVENTS = 'products.events',
}

export const KafkaTopicGroups = Object.values(KafkaTopicGroup);

export enum OutboxScope {
  WithAll = 'WithAll',
}

/**
 * @description - for the default is, if you filter by, you fetch it as well
 *
 */
export interface OutboxWithAllFilters {
  id?: string | string[];

  attributes?: string[];

  limit?: number;
}

@Scopes(() => ({
  [OutboxScope.WithAll]: ({
    id,
    attributes,

    limit,
  }: OutboxWithAllFilters = {}) => {
    const findOptions: {
      where: WhereOptions;
      include?: Includeable[];
      attributes?: string[];
      limit?: number;
    } = {
      where: {
        ...(id && { id }),
      },
      include: [],
      attributes: attributes,
      limit: limit,
    };

    return findOptions;
  },
}))
@Table({
  modelName: 'Outbox',
  tableName: 'Outbox',
  createdAt: 'createdAt',
  updatedAt: false,
  deletedAt: false,
})
export default class Outbox extends Model<Outbox, Partial<Outbox>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  /** TEXT since F-05: `KafkaTopicGroup` values plus one `<aggregate>.events` topic per domain. */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare topic: string;

  /** Kafka message key (per-aggregate ordering). Null for legacy payment rows (keyed by idempotency key). */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare aggregateId: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare eventName: string | null;

  // Any extra debug data that might have been generated during the executiong of the event itself
  @Column({ type: DataType.JSONB, allowNull: true })
  declare extra?: Record<string, any>;

  // The payload of the event itself
  @Column({ type: DataType.JSONB, allowNull: false })
  declare payload: any;

  // The error that occurred during the execution of the event itself
  @Column({ type: DataType.JSONB, allowNull: true })
  declare error?: any;

  @Column({ type: DataType.DATE, allowNull: true })
  declare publishedAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare attempts: number;

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare nextAttemptAt: Date;

  @CreatedAt
  declare createdAt: Date;
}

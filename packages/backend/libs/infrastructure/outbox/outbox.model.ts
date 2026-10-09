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

export type OutboxKind = 'event' | 'task';
export type OutboxStatus = 'pending' | 'published' | 'parked';

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

  /** `event` rows go to the log, `task` rows to a queue (S53 row contract, `data-model.md`). */
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'event' })
  declare kind: OutboxKind;

  /** `pending` → `published`, or `pending` → `parked` (10 attempts / non-retryable), `parked` → `pending` (requeue). */
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'pending' })
  declare status: OutboxStatus;

  /** Topic (`<aggregateType>.events`) for events, queue name for tasks. */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare topic: string;

  /** Message key (per-aggregate ordering); the database rejects null and empty. */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare aggregateId: string;

  /** Owning aggregate type; required for events. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare aggregateType: string | null;

  /** Lowercase dotted event type (or task type). */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare type: string | null;

  /** Legacy mirror of `type`, still written so existing readers keep working until the contract migration. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare eventName: string | null;

  /** Reason code when parked (never a payload value). */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare parkedReason: string | null;

  /** Claim lease: no other relay publishes this row until it passes. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseUntil: Date | null;

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

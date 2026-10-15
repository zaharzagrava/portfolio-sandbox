import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Append-only history of a subscription's versions (S17 FR-016); the store rejects UPDATE and DELETE. */
@Table({
  modelName: 'SubscriptionTransition',
  tableName: 'SubscriptionTransition',
  timestamps: false,
})
export default class SubscriptionTransition extends Model<
  SubscriptionTransition,
  Partial<SubscriptionTransition>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;
  @Column({ type: DataType.UUID, allowNull: false })
  declare subscriptionId: string;
  @Column({ type: DataType.TEXT, allowNull: true })
  declare fromStatus: string | null;
  @Column({ type: DataType.TEXT, allowNull: false }) declare toStatus: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare reason: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare actor: string;
  @Column({ type: DataType.DATE, allowNull: false }) declare at: Date;
  @Column({ type: DataType.INTEGER, allowNull: false }) declare version: number;
}

import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

export type LaunchEventStatus = 'SCHEDULED' | 'ON_SALE' | 'SOLD_OUT' | 'CLOSED';

@Table({ modelName: 'LaunchEvent', tableName: 'LaunchEvent', timestamps: true })
export default class LaunchEvent extends Model<
  LaunchEvent,
  Partial<LaunchEvent>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare venue: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare startsAt: Date;

  @Column({ type: DataType.DATE, allowNull: false })
  declare salesOpenAt: Date;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare seatCount: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 20 })
  declare seatsPerRow: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 2 })
  declare perUserLimit: number;

  /** How many queued users are let into the booking flow per second (admission control). */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 200 })
  declare admissionRatePerSec: number;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'SCHEDULED' })
  declare status: LaunchEventStatus;

  declare createdAt: Date;
  declare updatedAt: Date;
}

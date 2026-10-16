import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** One row per launch-event status change (III.7), written in the transaction of the change. */
@Table({
  modelName: 'LaunchEventHistory',
  tableName: 'LaunchEventHistory',
  timestamps: false,
})
export default class LaunchEventHistory extends Model<
  LaunchEventHistory,
  Partial<LaunchEventHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare launchEventId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare fromStatus: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare toStatus: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason: string | null;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('now()'),
  })
  declare at: Date;
}

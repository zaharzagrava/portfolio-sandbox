import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';
import type { LiveStatus } from '../../domain/live-state';
import type { StoredPin } from '../../domain/live-ports';

/** The authority for a stream's status, pin and pin version (S23 FR-041); Redis only holds derived copies. */
@Table({ modelName: 'LiveStream', tableName: 'LiveStream', timestamps: false })
export default class LiveStream extends Model<LiveStream, Partial<LiveStream>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  /** A plain reference: no foreign key to another domain's table (IX.4). */
  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'SCHEDULED' })
  declare status: LiveStatus;

  @Column({ type: DataType.UUID, allowNull: true })
  declare launchEventId: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare endedAt: Date | null;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('now()'),
  })
  declare createdAt: Date;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare pin: StoredPin | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare pinVersion: number;
}

import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** A viewer muted in one stream: durable, so a wipe of the fast store never lifts a mute (S23 FR-024). */
@Table({ modelName: 'LiveMute', tableName: 'LiveMute', timestamps: false })
export default class LiveMute extends Model<LiveMute, Partial<LiveMute>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false })
  declare streamId: string;

  /** A plain reference to identity's user: no foreign key (IX.4). */
  @PrimaryKey
  @Column({ type: DataType.UUID, allowNull: false })
  declare userId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare mutedBy: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('now()'),
  })
  declare mutedAt: Date;
}

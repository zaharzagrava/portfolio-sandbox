import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** History of a booking's state changes (III.7): one row per transition, written in the confirm transaction. */
@Table({
  modelName: 'BookingEvent',
  tableName: 'BookingEvent',
  timestamps: false,
})
export default class BookingEvent extends Model<
  BookingEvent,
  Partial<BookingEvent>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare bookingId: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare fromStatus: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare toStatus: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare holdId: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('now()'),
  })
  declare at: Date;
}

import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

@Table({ modelName: 'Booking', tableName: 'Booking', timestamps: true, updatedAt: false })
export default class Booking extends Model<Booking, Partial<Booking>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare eventId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare seat: number;

  @Column({ type: DataType.UUID, allowNull: false })
  declare userId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare holdId: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'CONFIRMED' })
  declare status: 'CONFIRMED' | 'CANCELLED';

  declare createdAt: Date;
}

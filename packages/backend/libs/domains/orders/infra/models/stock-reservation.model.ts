import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

@Table({ modelName: 'StockReservation', tableName: 'StockReservation', timestamps: true, updatedAt: false })
export default class StockReservation extends Model<StockReservation, Partial<StockReservation>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare bisOrderId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare productId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare quantity: number;

  /** POSTGRES = conditional row decrement; FLASH = Redis bucket (Postgres updated after payment). */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare source: 'POSTGRES' | 'FLASH';

  @Column({ type: DataType.UUID, allowNull: true })
  declare flashSaleId: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare bucket: number | null;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'HELD' })
  declare status: 'HELD' | 'CONVERTED' | 'RELEASED';

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  declare createdAt: Date;
}

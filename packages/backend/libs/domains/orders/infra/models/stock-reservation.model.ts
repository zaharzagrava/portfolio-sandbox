import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

@Table({
  modelName: 'StockReservation',
  tableName: 'StockReservation',
  timestamps: true,
  updatedAt: false,
})
export default class StockReservation extends Model<
  StockReservation,
  Partial<StockReservation>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare bisOrderId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare productId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare quantity: number;

  /** CATALOG = stock held by the catalog's `applyStockDelta`; FLASH = Redis bucket (legacy, S11); POSTGRES = legacy rows. */
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'CATALOG' })
  declare source: 'CATALOG' | 'POSTGRES' | 'FLASH';

  @Column({ type: DataType.TEXT, allowNull: true })
  declare sourceRef: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare releaseAttempts: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare nextReleaseAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare flashSaleId: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare bucket: number | null;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'HELD' })
  declare status:
    'REQUESTED' | 'HELD' | 'CONVERTED' | 'RELEASE_PENDING' | 'RELEASED';

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  declare createdAt: Date;
}

import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';
import type {
  FlashSaleStatus,
  StatusReason,
} from '../../domain/flash-sale-state';

/** A drop: `units` of one product at a fixed price inside `[startsAt, endsAt)` (S11 data-model §1). No association. */
@Table({ modelName: 'FlashSale', tableName: 'FlashSale', timestamps: true })
export default class FlashSale extends Model<FlashSale, Partial<FlashSale>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare productId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare priceMinor: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare currency: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare units: number;

  /** Hot-key splitting: stock lives in N Redis keys spread over cluster slots. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 16 })
  declare buckets: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 2 })
  declare perUserLimit: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 2000 })
  declare admissionRatePerSecond: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare startsAt: Date;

  @Column({ type: DataType.DATE, allowNull: false })
  declare endsAt: Date;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'SCHEDULED' })
  declare status: FlashSaleStatus;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare statusReason: StatusReason | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare version: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare endedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare reconciledAt: Date | null;

  declare createdAt: Date;
  declare updatedAt: Date;
}

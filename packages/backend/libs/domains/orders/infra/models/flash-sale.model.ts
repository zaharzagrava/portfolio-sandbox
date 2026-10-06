import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

export type FlashSaleStatus = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'RECONCILED';

@Table({ modelName: 'FlashSale', tableName: 'FlashSale', timestamps: true })
export default class FlashSale extends Model<FlashSale, Partial<FlashSale>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare productId: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare shopId: string | null;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare price: number;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare units: number;

  /** Hot-key splitting: stock lives in N Redis keys spread over cluster slots. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 16 })
  declare buckets: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 2 })
  declare perUserLimit: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare startsAt: Date;

  @Column({ type: DataType.DATE, allowNull: false })
  declare endsAt: Date;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'SCHEDULED' })
  declare status: FlashSaleStatus;

  declare createdAt: Date;
  declare updatedAt: Date;
}

import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Append-only bid log, range-partitioned by month on `createdAt` (S21 data-model §2). Written by `BidRepository`. */
@Table({ modelName: 'Bid', tableName: 'Bid', timestamps: false })
export default class Bid extends Model<Bid, Partial<Bid>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @PrimaryKey
  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @Column({ type: DataType.UUID, allowNull: false }) declare auctionId: string;
  @Column({ type: DataType.UUID, allowNull: false }) declare bidderId: string;
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare maxAmountMinor: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare outcome: string;
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare priceAfterMinor: string;
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare sequence: number;
}

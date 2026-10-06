import { Column, DataType, Model, PrimaryKey, Table } from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

export type AuctionStatus = 'OPEN' | 'CLOSED' | 'UNSOLD' | 'CANCELLED';

@Table({ modelName: 'Auction', tableName: 'Auction', timestamps: true })
export default class Auction extends Model<Auction, Partial<Auction>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false }) declare shopId: string;
  @Column({ type: DataType.UUID, allowNull: false }) declare productId: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare title: string;
  @Column({ type: DataType.BIGINT, allowNull: false }) declare startingPrice: number;
  @Column({ type: DataType.BIGINT, allowNull: false }) declare minIncrement: number;
  @Column({ type: DataType.BIGINT, allowNull: true }) declare reservePrice: number | null;
  @Column({ type: DataType.DATE, allowNull: false }) declare startsAt: Date;
  @Column({ type: DataType.DATE, allowNull: false }) declare endsAt: Date;
  @Column({ type: DataType.DATE, allowNull: false }) declare originalEndsAt: Date;
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'OPEN' }) declare status: AuctionStatus;
  @Column({ type: DataType.BIGINT, allowNull: false }) declare currentPrice: number;
  @Column({ type: DataType.UUID, allowNull: true }) declare leaderId: string | null;
  @Column({ type: DataType.UUID, allowNull: true }) declare winnerId: string | null;
  @Column({ type: DataType.BIGINT, allowNull: true }) declare finalPrice: number | null;
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 }) declare bidCount: number;
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 }) declare version: number;

  declare createdAt: Date;
  declare updatedAt: Date;
}

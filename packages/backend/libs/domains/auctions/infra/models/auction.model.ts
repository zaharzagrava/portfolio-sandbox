import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/**
 * The auction row (S21 data-model §1). Money is BIGINT in minor units: the driver returns it as a string, so the
 * repository reads rows through its own validated mapping (`safeNumber`) and never returns this class to a client.
 */
@Table({ modelName: 'Auction', tableName: 'Auction', timestamps: true })
export default class Auction extends Model<Auction, Partial<Auction>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false }) declare shopId: string;
  @Column({ type: DataType.UUID, allowNull: false }) declare productId: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare title: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare currency: string;
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare startingPriceMinor: string;
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare minIncrementMinor: string;
  @Column({ type: DataType.BIGINT, allowNull: true })
  declare reservePriceMinor: string | null;
  @Column({ type: DataType.DATE, allowNull: false }) declare startsAt: Date;
  @Column({ type: DataType.DATE, allowNull: false }) declare endsAt: Date;
  @Column({ type: DataType.DATE, allowNull: false })
  declare originalEndsAt: Date;
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'SCHEDULED' })
  declare status: string;
  @Column({ type: DataType.TEXT, allowNull: true })
  declare statusReason: string | null;
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare priceMinor: string;
  @Column({ type: DataType.UUID, allowNull: true }) declare leaderId:
    string | null;
  @Column({ type: DataType.BIGINT, allowNull: true })
  declare leaderMaxMinor: string | null;
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare bidCount: number;
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare version: number;
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare unitHeld: boolean;
  @Column({ type: DataType.DATE, allowNull: false })
  declare holdRequestedAt: Date;
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare returnPending: boolean;
  @Column({ type: DataType.UUID, allowNull: true }) declare winnerId:
    string | null;
  @Column({ type: DataType.BIGINT, allowNull: true })
  declare finalPriceMinor: string | null;
  @Column({ type: DataType.UUID, allowNull: true }) declare firstOrderId:
    string | null;
  @Column({ type: DataType.UUID, allowNull: true }) declare winnerOrderId:
    string | null;
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare settlementOrderVersion: number;
  @Column({ type: DataType.DATE, allowNull: true })
  declare offerExpiresAt: Date | null;
  @Column({ type: DataType.DATE, allowNull: true })
  declare closedAt: Date | null;

  declare createdAt: Date;
  declare updatedAt: Date;
}

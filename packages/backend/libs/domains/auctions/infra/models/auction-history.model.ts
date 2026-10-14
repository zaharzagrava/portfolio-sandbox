import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Append-only record of an auction's status changes, written in the transition's transaction (S21 data-model §3). */
@Table({
  modelName: 'AuctionHistory',
  tableName: 'AuctionHistory',
  timestamps: false,
})
export default class AuctionHistory extends Model<
  AuctionHistory,
  Partial<AuctionHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false }) declare auctionId: string;
  @Column({ type: DataType.TEXT, allowNull: true }) declare fromStatus:
    string | null;
  @Column({ type: DataType.TEXT, allowNull: false }) declare toStatus: string;
  @Column({ type: DataType.TEXT, allowNull: true }) declare reason:
    string | null;
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare auctionVersion: number;
  @Column({ type: DataType.DATE, allowNull: false }) declare at: Date;
  @Column({ type: DataType.TEXT, allowNull: false }) declare actor: string;
}

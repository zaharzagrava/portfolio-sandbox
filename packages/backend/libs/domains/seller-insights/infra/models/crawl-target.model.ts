import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** One normalised competitor URL and its crawl state, shared by every shop that watches it (S41 data-model.md). */
@Table({
  modelName: 'CrawlTarget',
  tableName: 'CrawlTarget',
  timestamps: false,
})
export default class CrawlTarget extends Model<
  CrawlTarget,
  Partial<CrawlTarget>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.TEXT, allowNull: false, unique: true })
  declare url: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare host: string;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare lastPriceMinor: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare currency: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare simhash: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare unchangedStreak: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare lastStatus: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastCheckedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare nextCheckAt: Date;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare observationNo: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare evaluatedNo: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastObservedAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare noPriceStreak: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare errorStreak: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare queuedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare retiredAt: Date | null;
}

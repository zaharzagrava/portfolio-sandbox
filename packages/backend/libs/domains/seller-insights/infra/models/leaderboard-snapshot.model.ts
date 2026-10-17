import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/**
 * The frozen top 100 of one board of one period: `period` is the period id (`2026-W40` / `2026-10`), `board` is `all` or
 * `cat:<category>`. The shop name is the name at snapshot time; `participants` the ranked shops of the board then.
 */
@Table({
  modelName: 'LeaderboardSnapshot',
  tableName: 'LeaderboardSnapshot',
  timestamps: true,
  updatedAt: false,
})
export default class LeaderboardSnapshot extends Model<
  LeaderboardSnapshot,
  Partial<LeaderboardSnapshot>
> {
  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare period: string;

  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare board: string;

  @PrimaryKey
  @Column({ type: DataType.INTEGER })
  declare rank: number;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare revenue: string | number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare shopName: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare participants: number;
}

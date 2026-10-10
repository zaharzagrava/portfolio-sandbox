import {
  AutoIncrement,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** One row per status move of a run, written in the same transaction as the move. */
@Table({
  modelName: 'SearchReindexRunHistory',
  tableName: 'SearchReindexRunHistory',
  timestamps: false,
})
export default class SearchReindexRunHistory extends Model<
  SearchReindexRunHistory,
  Partial<SearchReindexRunHistory>
> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT })
  declare historyId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare runId: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare fromStatus: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare toStatus: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare detail: Record<string, unknown>;
}

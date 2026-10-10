import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import type { ReindexRunStatus } from '../../domain/reindex-run-status';
import type { ReindexRunKind } from '../../domain/ports';

/** One reindex or rollback run. At most one run is active at a time (partial unique index). */
@Table({
  modelName: 'SearchReindexRun',
  tableName: 'SearchReindexRun',
  timestamps: false,
})
export default class SearchReindexRun extends Model<
  SearchReindexRun,
  Partial<SearchReindexRun>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare runId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare kind: ReindexRunKind;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare status: ReindexRunStatus;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare mappingVersion: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare embeddingModelVersion: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare index: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare previousIndex: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare previousRetiresAt: Date | null;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare replayPosition: Record<string, unknown>;

  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare documents: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare ledger: Record<string, unknown>;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare failureReason: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare switchingAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare requestedBy: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;
}

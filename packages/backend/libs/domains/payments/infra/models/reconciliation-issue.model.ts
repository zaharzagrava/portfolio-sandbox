import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** A difference between the provider's statement and the ledger, worked by finance operators. */
@Table({
  modelName: 'ReconciliationIssue',
  tableName: 'ReconciliationIssue',
  timestamps: true,
  updatedAt: false,
  deletedAt: false,
})
export default class ReconciliationIssue extends Model<
  ReconciliationIssue,
  Partial<ReconciliationIssue>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare runId: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare day: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare kind: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare reference: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare details: Record<string, unknown>;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'OPEN' })
  declare status: 'OPEN' | 'RESOLVED';

  @Column({ type: DataType.TEXT, allowNull: true })
  declare resolution: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare note: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare resolvedBy: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare resolvedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare adjustmentJournalId: string | null;

  declare createdAt: Date;
}

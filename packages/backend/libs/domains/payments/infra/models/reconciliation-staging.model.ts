import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Issues collected during a run; promoted to `ReconciliationIssue` in the closing transaction. */
@Table({
  modelName: 'ReconciliationStaging',
  tableName: 'ReconciliationStaging',
  timestamps: false,
})
export default class ReconciliationStaging extends Model<
  ReconciliationStaging,
  Partial<ReconciliationStaging>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare runId: string;

  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare kind: string;

  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare reference: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare details: Record<string, unknown>;
}

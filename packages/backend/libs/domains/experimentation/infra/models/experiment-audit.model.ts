import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** One applied change of an experiment. Append-only: the repository has no update or delete for it, and there is no `updatedAt`. */
@Table({
  modelName: 'ExperimentAudit',
  tableName: 'ExperimentAudit',
  timestamps: false,
  updatedAt: false,
})
export default class ExperimentAuditModel extends Model<
  ExperimentAuditModel,
  Partial<ExperimentAuditModel>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare id: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare experimentKey: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare action: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare actorId: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare requestId: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare before: unknown;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare after: unknown;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;
}

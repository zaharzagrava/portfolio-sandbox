import {
  AutoIncrement,
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** One applied change of a flag. Append-only: the repository has no update or delete for it, and there is no `updatedAt`. */
@Table({
  modelName: 'FlagAudit',
  tableName: 'FlagAudit',
  timestamps: false,
  updatedAt: false,
})
export default class FlagAuditModel extends Model<
  FlagAuditModel,
  Partial<FlagAuditModel>
> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT })
  declare id: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare flagKey: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare actorId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare action: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare before: unknown;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare after: unknown;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare requestId: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;
}

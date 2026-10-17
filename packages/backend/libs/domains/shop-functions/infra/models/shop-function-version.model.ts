import { Column, DataType, Model, Table } from 'sequelize-typescript';

/** One submitted version of a function's source; `(functionId, version)` is the key. */
@Table({
  modelName: 'ShopFunctionVersion',
  tableName: 'ShopFunctionVersion',
  timestamps: false,
})
export default class ShopFunctionVersion extends Model<
  ShopFunctionVersion,
  Partial<ShopFunctionVersion>
> {
  @Column({ type: DataType.UUID, primaryKey: true })
  declare functionId: string;

  @Column({ type: DataType.INTEGER, primaryKey: true })
  declare version: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare source: string;

  @Column({ type: DataType.CHAR(64), allowNull: false })
  declare sourceHash: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'QUEUED' })
  declare status: 'QUEUED' | 'TESTING' | 'ACTIVE' | 'REJECTED' | 'SUPERSEDED';

  @Column({ type: DataType.JSONB, allowNull: true })
  declare verdicts: unknown[] | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare rejectionReason: 'judge_unavailable' | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare judgeAttempts: number;

  @Column({ type: DataType.UUID, allowNull: false })
  declare createdBy: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare judgedAt: Date | null;
}

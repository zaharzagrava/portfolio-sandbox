import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** The record of the weekly run of one period; a re-execution moves the same row (S15 data-model.md). */
@Table({ modelName: 'PayoutRun', tableName: 'PayoutRun', timestamps: false })
export default class PayoutRun extends Model<PayoutRun, Partial<PayoutRun>> {
  @PrimaryKey
  @Column({ type: DataType.DATEONLY })
  declare periodStart: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare status: 'RUNNING' | 'COMPLETED' | 'FAILED';

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare created: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare existing: number;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare skipped: Record<string, number>;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare failureCode: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare startedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}

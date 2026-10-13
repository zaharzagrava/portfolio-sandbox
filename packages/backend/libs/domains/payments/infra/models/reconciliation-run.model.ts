import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** One reconciliation run per (provider, UTC day). */
@Table({
  modelName: 'ReconciliationRun',
  tableName: 'ReconciliationRun',
  timestamps: false,
})
export default class ReconciliationRun extends Model<
  ReconciliationRun,
  Partial<ReconciliationRun>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare provider: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare day: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'RUNNING' })
  declare status: 'RUNNING' | 'COMPLETED' | 'FAILED';

  @Column({ type: DataType.DATE, allowNull: false })
  declare startedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseUntil: Date | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare failureCode: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare providerLines: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare ledgerJournals: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare matched: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare issues: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare skipped: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;
}

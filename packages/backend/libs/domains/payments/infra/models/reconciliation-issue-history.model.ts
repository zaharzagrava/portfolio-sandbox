import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Insert-only: one row per state change of an issue (operator or system). */
@Table({
  modelName: 'ReconciliationIssueHistory',
  tableName: 'ReconciliationIssueHistory',
  timestamps: false,
})
export default class ReconciliationIssueHistory extends Model<
  ReconciliationIssueHistory,
  Partial<ReconciliationIssueHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare issueId: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare actor: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare from: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare to: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare resolution: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare note: string | null;
}

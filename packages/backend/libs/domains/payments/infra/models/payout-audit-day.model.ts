import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** The marker of one daily audit (the previous UTC day's paid payouts against the provider). */
@Table({
  modelName: 'PayoutAuditDay',
  tableName: 'PayoutAuditDay',
  timestamps: false,
})
export default class PayoutAuditDay extends Model<
  PayoutAuditDay,
  Partial<PayoutAuditDay>
> {
  @PrimaryKey
  @Column({ type: DataType.DATEONLY })
  declare day: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare status: 'RUNNING' | 'COMPLETED' | 'FAILED';

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare checked: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare discrepancies: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare startedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;
}

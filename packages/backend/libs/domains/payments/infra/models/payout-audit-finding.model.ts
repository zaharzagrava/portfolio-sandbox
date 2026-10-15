import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Primary key (payoutId, kind): inserting it once is what makes "every difference reported once". */
@Table({
  modelName: 'PayoutAuditFinding',
  tableName: 'PayoutAuditFinding',
  timestamps: false,
})
export default class PayoutAuditFinding extends Model<
  PayoutAuditFinding,
  Partial<PayoutAuditFinding>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare payoutId: string;

  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare kind: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare day: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare foundAt: Date;
}

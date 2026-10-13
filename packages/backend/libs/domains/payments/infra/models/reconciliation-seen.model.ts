import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Provider references seen during a run, for the reverse direction beyond the in-memory bound. */
@Table({
  modelName: 'ReconciliationSeen',
  tableName: 'ReconciliationSeen',
  timestamps: false,
})
export default class ReconciliationSeen extends Model<
  ReconciliationSeen,
  Partial<ReconciliationSeen>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare runId: string;

  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare reference: string;
}

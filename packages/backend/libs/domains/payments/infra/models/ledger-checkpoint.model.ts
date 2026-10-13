import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Where the invariant checker last proved an account shard: its balance at the end of a closed day. */
@Table({
  modelName: 'LedgerCheckpoint',
  tableName: 'LedgerCheckpoint',
  timestamps: false,
})
export default class LedgerCheckpoint extends Model<
  LedgerCheckpoint,
  Partial<LedgerCheckpoint>
> {
  @PrimaryKey
  @Column({ type: DataType.STRING(255) })
  declare accountId: string;

  @PrimaryKey
  @Column({ type: DataType.SMALLINT, defaultValue: 0 })
  declare shard: number;

  @PrimaryKey
  @Column({ type: DataType.CHAR(3) })
  declare currency: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare verifiedThrough: Date;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare balanceMinor: number;
}

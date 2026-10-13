import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** The running balance of one (account, shard, currency); moved by atomic increments inside the posting. */
@Table({
  modelName: 'AccountBalance',
  tableName: 'AccountBalance',
  timestamps: false,
})
export default class AccountBalance extends Model<
  AccountBalance,
  Partial<AccountBalance>
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

  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare balanceMinor: number;

  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare version: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}

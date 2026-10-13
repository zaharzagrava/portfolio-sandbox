import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Resumable keyset position of `ledger.backfill-balances`. */
@Table({
  modelName: 'LedgerBackfillCursor',
  tableName: 'LedgerBackfillCursor',
  timestamps: false,
})
export default class LedgerBackfillCursor extends Model<
  LedgerBackfillCursor,
  Partial<LedgerBackfillCursor>
> {
  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare name: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastCreatedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare lastId: string | null;

  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare rowsDone: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;
}

import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** The header of a journal: unique per (kind, reference), insert-only. No association (S14 FR-046). */
@Table({
  modelName: 'LedgerJournal',
  tableName: 'LedgerJournal',
  timestamps: true,
  updatedAt: false,
  deletedAt: false,
})
export default class LedgerJournal extends Model<
  LedgerJournal,
  Partial<LedgerJournal>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare id: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare kind: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare reference: string;

  @Column({ type: DataType.CHAR(3), allowNull: false })
  declare currency: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare postedAt: Date;

  @Column({ type: DataType.CHAR(64), allowNull: false })
  declare fingerprint: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare paymentId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare orderId: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare paymentRef: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare refundRef: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare userId: string | null;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare clearingMinor: number | null;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare amountMinor: number | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare reversesJournalId: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare correctsDay: string | null;

  declare createdAt: Date;
}

import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';
import type { JournalKind } from '../../domain/journal';

/**
 * One line of a journal. Append-only (the store rejects UPDATE and DELETE), partitioned monthly on `createdAt`,
 * which is the journal's `postedAt`. No association: `paymentId` and `accountId` are plain references (S14 FR-046).
 */
@Table({
  modelName: 'LedgerEntry',
  tableName: 'LedgerEntry',
  timestamps: true,
  updatedAt: false, // ledger entries are immutable
  deletedAt: false,
})
export default class LedgerEntry extends Model<
  LedgerEntry,
  Partial<LedgerEntry>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  /** Groups the lines of one balanced posting; the DB rejects a journal whose lines don't sum to 0. */
  @Column({ type: DataType.UUID, allowNull: false })
  declare journalId: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'SALE' })
  declare kind: JournalKind;

  /** The payment id of the sale or refund this line belongs to; null for journals that are not about one payment. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare paymentId: string | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare accountId: string;

  /** 0 for every account but the three hot ones. */
  @Column({ type: DataType.SMALLINT, allowNull: false, defaultValue: 0 })
  declare shard: number;

  @Column({ type: DataType.CHAR(3), allowNull: false, defaultValue: 'EUR' })
  declare currency: string;

  // Signed integer money: positive = credit (money in), negative = debit (money out), in minor units.
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare amount: bigint;

  /** The journal's `postedAt`. */
  @CreatedAt
  declare createdAt: Date;
}

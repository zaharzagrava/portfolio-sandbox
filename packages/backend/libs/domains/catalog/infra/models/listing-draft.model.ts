import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import type { DraftStatus } from '../../domain/draft-status';

/**
 * A working copy of one listing (S06). Plain id columns: no association to the shop, the product or the user (IX.4);
 * the repository reads and writes it with parameterised SQL.
 */
@Table({
  modelName: 'ListingDraft',
  tableName: 'ListingDraft',
  timestamps: false,
})
export default class ListingDraft extends Model<
  ListingDraft,
  Partial<ListingDraft>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare productId: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare baseProductVersion: number | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare status: DraftStatus;

  @Column({ type: DataType.UUID, allowNull: false })
  declare createdBy: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare publishLeaseId: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare publishLeaseExpiresAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare publishedAt: Date | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare snapshotKey: string | null;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare snapshotSeq: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}

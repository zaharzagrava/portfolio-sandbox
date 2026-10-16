import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/**
 * One order export (S12 data-model). Plain ID columns, no association, no foreign key. The repository writes through
 * conditional SQL (fenced updates), so this class mainly declares the table for the ownership registry. The legacy
 * `kind`, `rows`, `error`, `objectKey` columns are deliberately not mapped.
 */
@Table({ modelName: 'ExportJob', tableName: 'ExportJob', timestamps: true })
export default class ExportJob extends Model<ExportJob, Partial<ExportJob>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare createdBy: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'QUEUED' })
  declare status: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare attempt: number;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare totalRows: string | null;

  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare rowsWritten: string;

  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare bytesWritten: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare failureCode: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare fileKey: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare leaseHolder: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare leaseExpiresAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare finishedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare expiresAt: Date | null;
}

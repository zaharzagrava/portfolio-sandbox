import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

export type InboxStatus =
  'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'UNMATCHED' | 'REJECTED' | 'FAILED';

/**
 * The inbox (owner `infrastructure:inbox`, IX.3). The table keeps its pre-S53 name `ProcessedWebhookEvent` (IX.2) and
 * its `provider` column, which is the inbox `source` (a provider such as `stripe`, or a consumer name for
 * `recordOnce`); `(source, eventId)` is the primary key and the atomic claim. Domains never touch it (IX.6): they use
 * `InboxService`.
 */
@Table({
  modelName: 'ProcessedWebhookEvent',
  tableName: 'ProcessedWebhookEvent',
  timestamps: false,
})
export default class ProcessedWebhookEvent extends Model {
  @PrimaryKey
  @Column({ type: DataType.TEXT, field: 'provider' })
  declare source: string;

  @PrimaryKey
  @Column(DataType.TEXT)
  declare eventId: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'PROCESSED' })
  declare status: InboxStatus;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare attempts: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare claimedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare handledAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare processedAt: Date;

  /** A short reason code, never a payload value. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare detail: string | null;
}

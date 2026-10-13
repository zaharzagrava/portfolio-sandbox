import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Addresses that must not be contacted on a channel: hard bounces, complaints, STOP, dead push tokens. Keys are normalized. */
@Table({
  modelName: 'NotificationSuppression',
  tableName: 'NotificationSuppression',
  timestamps: false,
})
export default class NotificationSuppression extends Model<
  NotificationSuppression,
  Partial<NotificationSuppression>
> {
  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare channel: string;

  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare address: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare reason: string;

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare createdAt: Date;
}

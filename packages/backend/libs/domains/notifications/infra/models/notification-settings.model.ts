import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Per-user delivery settings. `userId` is a plain id: no association with the identity table (IX.4). */
@Table({
  modelName: 'NotificationSettings',
  tableName: 'NotificationSettings',
  timestamps: false,
})
export default class NotificationSettings extends Model<
  NotificationSettings,
  Partial<NotificationSettings>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare userId: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'UTC' })
  declare timezone: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'en' })
  declare locale: string;

  /** `HH:MM`, set together with `quietEnd` or both null (CHECK `NotificationSettings_quiet_pair_check`). */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare quietStart: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare quietEnd: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare phone: string | null;

  /** Set by the code check; cleared in the statement that changes `phone`. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare phoneVerifiedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare updatedAt: Date;
}

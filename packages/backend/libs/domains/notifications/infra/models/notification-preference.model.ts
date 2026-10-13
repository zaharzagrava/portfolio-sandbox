import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Sparse: a row is an explicit override of the catalog default for (user, category, channel). */
@Table({
  modelName: 'NotificationPreference',
  tableName: 'NotificationPreference',
  timestamps: false,
})
export default class NotificationPreference extends Model<
  NotificationPreference,
  Partial<NotificationPreference>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare userId: string;

  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare category: string;

  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare channel: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare enabled: boolean;

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare updatedAt: Date;
}

import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/**
 * A push token belongs to exactly one user (the latest to register it). `id` is the public handle (the token is never
 * returned or put in a URL); `tokenHash` is the SHA-256 of the token, hex.
 */
@Table({ modelName: 'PushDevice', tableName: 'PushDevice', timestamps: false })
export default class PushDevice extends Model<PushDevice, Partial<PushDevice>> {
  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare token: string;

  @Column({
    type: DataType.UUID,
    allowNull: false,
    defaultValue: DataType.UUIDV4,
  })
  declare id: string;

  @Column({ type: DataType.CHAR(64), allowNull: true })
  declare tokenHash: string | null;

  @Column({ type: DataType.UUID, allowNull: false })
  declare userId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare platform: 'ios' | 'android' | 'web';

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare lastSeenAt: Date;
}

import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** One row per user; no row = no second factor. Read and written only by `SecondFactorRepository`. */
@Table({
  modelName: 'SecondFactor',
  tableName: 'SecondFactor',
  timestamps: true,
})
export default class SecondFactor extends Model<
  SecondFactor,
  Partial<SecondFactor>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare userId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare state: 'pending' | 'enabled';

  @Column({ type: DataType.TEXT, allowNull: false })
  declare secretSealed: string;

  @Column({ type: DataType.SMALLINT, allowNull: false, defaultValue: 0 })
  declare sealVersion: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare pendingExpiresAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare enabledAt: Date | null;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare lastStep: string | null;
}

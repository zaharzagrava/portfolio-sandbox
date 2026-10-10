import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Created lazily by the first attempt on a challenge token: attempts used and whether a code already won. */
@Table({
  modelName: 'MfaChallengeState',
  tableName: 'MfaChallengeState',
  timestamps: false,
})
export default class MfaChallengeState extends Model<
  MfaChallengeState,
  Partial<MfaChallengeState>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare jti: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare userId: string;

  @Column({ type: DataType.SMALLINT, allowNull: false })
  declare attempts: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare spentAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;
}

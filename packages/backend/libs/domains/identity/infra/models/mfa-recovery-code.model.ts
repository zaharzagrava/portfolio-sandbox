import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** One keyed digest per recovery code; `usedAt` is set by exactly one conditional update. */
@Table({
  modelName: 'MfaRecoveryCode',
  tableName: 'MfaRecoveryCode',
  timestamps: true,
  updatedAt: false,
})
export default class MfaRecoveryCode extends Model<
  MfaRecoveryCode,
  Partial<MfaRecoveryCode>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare userId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare digest: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare usedAt: Date | null;

  @CreatedAt
  declare createdAt: Date;
}

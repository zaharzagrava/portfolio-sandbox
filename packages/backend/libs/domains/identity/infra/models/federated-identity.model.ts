import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';
import User from './user.model';

@Table({
  modelName: 'FederatedIdentity',
  tableName: 'FederatedIdentity',
  timestamps: false,
})
export default class FederatedIdentity extends Model<
  FederatedIdentity,
  Partial<FederatedIdentity>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @ForeignKey(() => User)
  @Column({ type: DataType.UUID, allowNull: false })
  declare userId: string;

  @BelongsTo(() => User, { foreignKey: 'userId' })
  declare user: User;

  /** `google`, or `shop:<shopId>` for a shop's enterprise IdP (SD-02). */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare provider: string;

  /** The IdP's stable `sub` claim - never the email (emails get reassigned). */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare subject: string;

  /** A hint copied from the provider's claim (null allowed): never a key, never proof that the user owns the address. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare email: string | null;

  /** The account-linking wipe committed but its session revocation has not been confirmed yet (R-11). */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare wipePending: boolean;

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare createdAt: Date;
}

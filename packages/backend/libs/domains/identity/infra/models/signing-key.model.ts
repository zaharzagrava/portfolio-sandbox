import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

export type SigningKeyStatus = 'NEXT' | 'ACTIVE' | 'RETIRED';

@Table({ modelName: 'SigningKey', tableName: 'SigningKey', timestamps: false })
export default class SigningKey extends Model<SigningKey, Partial<SigningKey>> {
  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare kid: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare alg: 'ES256' | 'RS256';

  @Column({ type: DataType.JSONB, allowNull: false })
  declare publicJwk: Record<string, unknown>;

  /** AES-256-GCM encrypted PKCS#8 PEM (see SecretBox). */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare privateKeyEnc: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare status: SigningKeyStatus;

  @Column({ type: DataType.DATE, allowNull: true })
  declare activatedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare retiredAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare createdAt: Date;
}

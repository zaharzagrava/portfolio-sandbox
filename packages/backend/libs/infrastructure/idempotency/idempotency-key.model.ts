import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/**
 * Technical table owned by `infrastructure:idempotency` (IX.3). Registered only inside this lib's module;
 * the repository reaches it through raw conditional statements so the claim stays one atomic round trip (III.6).
 */
@Table({
  modelName: 'IdempotencyKey',
  tableName: 'IdempotencyKey',
  timestamps: false,
})
export class IdempotencyKeyModel extends Model {
  @PrimaryKey @Column(DataType.UUID) declare id: string;
  @Column(DataType.STRING(160)) declare scope: string;
  @Column(DataType.STRING(128)) declare key: string;
  @Column(DataType.CHAR(64)) declare fingerprint: string;
  @Column(DataType.STRING(16)) declare state: 'in_flight' | 'completed';
  @Column({ type: DataType.UUID, field: 'claim_token' })
  declare claimToken: string;
  @Column({ type: DataType.DATE, field: 'lock_expires_at' })
  declare lockExpiresAt: Date;
  @Column({ type: DataType.SMALLINT, field: 'response_status' })
  declare responseStatus: number | null;
  @Column({ type: DataType.JSONB, field: 'response_headers' })
  declare responseHeaders: Record<string, string> | null;
  @Column({ type: DataType.BLOB, field: 'response_body' })
  declare responseBody: Buffer | null;
  @Column({ type: DataType.BOOLEAN, field: 'body_stored' })
  declare bodyStored: boolean;
  @Column({ type: DataType.DATE, field: 'created_at' }) declare createdAt: Date;
  @Column({ type: DataType.DATE, field: 'expires_at' }) declare expiresAt: Date;
}

import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/**
 * Chat-owned index of every stored message: the cross-month guard of `(channelId, seq)` and
 * `(channelId, authorId, clientMessageId)` (a partitioned table cannot enforce either across months) and the sync
 * path. Written only by the insert trigger of `ChatMessage`; `bodyHash` is sha-256 of body, `0x1f` and replyToId, so
 * a replay is compared without copying the body.
 */
@Table({
  modelName: 'ChatMessageIndex',
  tableName: 'ChatMessageIndex',
  timestamps: false,
})
export default class ChatMessageIndex extends Model<
  ChatMessageIndex,
  Partial<ChatMessageIndex>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare channelId: string;

  @PrimaryKey
  @Column({ type: DataType.BIGINT })
  declare seq: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare messageId: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @Column({ type: DataType.UUID, allowNull: false })
  declare authorId: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare clientMessageId: string | null;

  @Column({ type: DataType.BLOB, allowNull: false })
  declare bodyHash: Buffer;
}

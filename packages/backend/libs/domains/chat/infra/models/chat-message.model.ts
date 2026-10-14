import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/**
 * Registers the table with the connection. `ChatMessage` is range-partitioned by month on `createdAt` (primary key
 * `(id, createdAt)`); the application reads and writes it through the repositories' SQL, and the Rust gateway inserts
 * rows with its own statement. The sequence number `seq` is assigned by the database trigger, never by a client.
 * `authorId` and `replyToId` are plain ids (no foreign key: not expressible across partitions / owners).
 */
@Table({
  modelName: 'ChatMessage',
  tableName: 'ChatMessage',
  createdAt: 'createdAt',
  updatedAt: false,
})
export default class ChatMessage extends Model<
  ChatMessage,
  Partial<ChatMessage>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @PrimaryKey
  @CreatedAt
  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @Column({ type: DataType.UUID, allowNull: false })
  declare channelId: string;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare seq: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare authorId: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare replyToId: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare clientMessageId: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare body: string;

  /** Moderation/self soft-delete; the row stays as a tombstone that keeps its sequence number. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare deletedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare deletedBy: string | null;
}

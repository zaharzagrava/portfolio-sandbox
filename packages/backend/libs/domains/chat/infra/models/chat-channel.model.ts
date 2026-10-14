import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/**
 * Registers the table with the connection (ownership registry, migrations). Every reference to another owner
 * (`productId`, `shopId`, `sellerId`) is a plain id: no association, no foreign key (IX.4). The application reads
 * and writes through the repositories' parameterised SQL, not through this model.
 */
@Table({
  modelName: 'ChatChannel',
  tableName: 'ChatChannel',
  timestamps: true,
})
export default class ChatChannel extends Model<
  ChatChannel,
  Partial<ChatChannel>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  /** One channel per product - enforced via a unique index. */
  @Column({ type: DataType.UUID, allowNull: false, unique: true })
  declare productId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  /** The creating user. */
  @Column({ type: DataType.UUID, allowNull: false })
  declare sellerId: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare isArchived: boolean;

  @Column({ type: DataType.DATE, allowNull: true })
  declare archivedAt: Date | null;

  /** The channel's sequence counter, advanced by the insert trigger of `ChatMessage`. */
  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare lastSeq: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastMessageAt: Date | null;

  /** Kept by the `chat_member_count` trigger. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare activeMemberCount: number;

  /** Incremented in the transaction of a message delete; part of the recent-window cache key. */
  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare deleteEpoch: string;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}

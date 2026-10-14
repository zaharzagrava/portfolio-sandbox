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
import {
  ChatChannelMemberRole,
  ChatChannelMemberStatus,
} from '../../domain/chat.constants';

const ROLES = Object.values(ChatChannelMemberRole);
const STATUSES = Object.values(ChatChannelMemberStatus);

/**
 * Registers the table with the connection. `userId` is a plain id (no association to the identity owner, IX.4); the
 * Rust gateway reads and creates rows of this table with its own statements, so the shape is a contract (AS-58).
 */
@Table({
  modelName: 'ChatChannelMember',
  tableName: 'ChatChannelMember',
  timestamps: true,
})
export default class ChatChannelMember extends Model<
  ChatChannelMember,
  Partial<ChatChannelMember>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare channelId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare userId: string;

  @Column({
    type: DataType.ENUM(...ROLES),
    allowNull: false,
    defaultValue: ChatChannelMemberRole.MEMBER,
  })
  declare role: ChatChannelMemberRole;

  @Column({
    type: DataType.ENUM(...STATUSES),
    allowNull: false,
    defaultValue: ChatChannelMemberStatus.ACTIVE,
  })
  declare status: ChatChannelMemberStatus;

  /** Temporary mute - the Rust gateway rejects sends while this is in the future. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare mutedUntil: Date | null;

  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare lastReadSeq: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastReadAt: Date | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}

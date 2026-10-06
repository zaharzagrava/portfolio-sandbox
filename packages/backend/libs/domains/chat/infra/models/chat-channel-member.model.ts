import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  Model,
  PrimaryKey,
  Scopes,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Includeable, Sequelize, WhereOptions } from 'sequelize';
import ChatChannel from './chat-channel.model';
import { UserModel as User } from '@app/domains/identity';

export enum ChatChannelMemberRole {
  OWNER = 'OWNER',
  MODERATOR = 'MODERATOR',
  MEMBER = 'MEMBER',
}

export const ChatChannelMemberRoles = Object.values(ChatChannelMemberRole);

export enum ChatChannelMemberStatus {
  ACTIVE = 'ACTIVE',
  BANNED = 'BANNED',
}

export const ChatChannelMemberStatuses = Object.values(
  ChatChannelMemberStatus,
);

export enum ChatChannelMemberScope {
  WithAll = 'WithAll',
}

export interface ChatChannelMemberWithAllFilters {
  id?: string | string[];
  channelId?: string | string[];
  userId?: string | string[];
  role?: ChatChannelMemberRole | ChatChannelMemberRole[];
  status?: ChatChannelMemberStatus | ChatChannelMemberStatus[];
  attributes?: string[];
  limit?: number;
}

@Scopes(() => ({
  [ChatChannelMemberScope.WithAll]: ({
    id,
    channelId,
    userId,
    role,
    status,
    attributes,
    limit,
  }: ChatChannelMemberWithAllFilters = {}) => {
    const findOptions: {
      where: WhereOptions;
      include?: Includeable[];
      attributes?: string[];
      limit?: number;
    } = {
      where: {
        ...(id && { id }),
        ...(channelId && { channelId }),
        ...(userId && { userId }),
        ...(role && { role }),
        ...(status && { status }),
      },
      include: [],
      attributes,
      limit,
    };

    return findOptions;
  },
}))
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

  @ForeignKey(() => ChatChannel)
  @Column({ type: DataType.UUID, allowNull: false })
  declare channelId: string;

  @BelongsTo(() => ChatChannel, { foreignKey: 'channelId' })
  declare channel: ChatChannel;

  @ForeignKey(() => User)
  @Column({ type: DataType.UUID, allowNull: false })
  declare userId: string;

  @BelongsTo(() => User, { foreignKey: 'userId' })
  declare user: User;

  @Column({
    type: DataType.ENUM(...ChatChannelMemberRoles),
    allowNull: false,
    defaultValue: ChatChannelMemberRole.MEMBER,
  })
  declare role: ChatChannelMemberRole;

  @Column({
    type: DataType.ENUM(...ChatChannelMemberStatuses),
    allowNull: false,
    defaultValue: ChatChannelMemberStatus.ACTIVE,
  })
  declare status: ChatChannelMemberStatus;

  /** Temporary mute - the Rust gateway rejects sends while this is in the future. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare mutedUntil: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastReadAt: Date | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}

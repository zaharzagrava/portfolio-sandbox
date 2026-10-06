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
} from 'sequelize-typescript';
import { Includeable, Op, Sequelize, WhereOptions } from 'sequelize';
import ChatChannel from './chat-channel.model';
import { UserModel as User } from '@app/domains/identity';

export enum ChatMessageScope {
  WithAll = 'WithAll',
}

export interface ChatMessageWithAllFilters {
  id?: string | string[];
  channelId?: string | string[];
  authorId?: string | string[];
  /** Cursor pagination - uuidv7 ids are time-sortable, so this is a `<` on id. */
  beforeId?: string;
  includeDeleted?: boolean;
  attributes?: string[];
  limit?: number;
}

@Scopes(() => ({
  [ChatMessageScope.WithAll]: ({
    id,
    channelId,
    authorId,
    beforeId,
    includeDeleted,
    attributes,
    limit,
  }: ChatMessageWithAllFilters = {}) => {
    const findOptions: {
      where: WhereOptions;
      include?: Includeable[];
      attributes?: string[];
      limit?: number;
      order?: any;
    } = {
      where: {
        ...(id && { id }),
        ...(channelId && { channelId }),
        ...(authorId && { authorId }),
        ...(beforeId && { id: { [Op.lt]: beforeId } }),
        ...(!includeDeleted && { deletedAt: null }),
      },
      include: [],
      attributes,
      limit,
      order: [['id', 'DESC']],
    };

    return findOptions;
  },
}))
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
  /**
   * uuidv7 primary key doubles as the pagination cursor (time-sortable), so
   * scrollback needs no separate sequence or `createdAt` index. This row is
   * normally inserted by the Rust chat-gateway directly, not through
   * Sequelize - this model exists for history reads and migrations.
   */
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
  declare authorId: string;

  @BelongsTo(() => User, { foreignKey: 'authorId' })
  declare author: User;

  @ForeignKey(() => ChatMessage)
  @Column({ type: DataType.UUID, allowNull: true })
  declare replyToId: string | null;

  @BelongsTo(() => ChatMessage, { foreignKey: 'replyToId' })
  declare replyTo: ChatMessage;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare body: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare editedAt: Date | null;

  /** Moderation/self soft-delete; content is left in place but hidden. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare deletedAt: Date | null;

  @CreatedAt
  declare createdAt: Date;
}

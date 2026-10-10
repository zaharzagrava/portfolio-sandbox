import {
  Column,
  CreatedAt,
  Default,
  DeletedAt,
  IsUUID,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
  Scopes,
  DataType,
  HasOne,
  HasMany,
} from 'sequelize-typescript';
import { v4 as uuidv4 } from 'uuid';
import { Includeable, Sequelize, WhereOptions } from 'sequelize';

export enum Role {
  ADMIN = 'ADMIN',
  MODERATOR = 'MODERATOR',
  SELLER = 'SELLER',
  USER = 'USER',
}

export enum UserScope {
  WithAll = 'WithAll',
}

/**
 * @description - for the default is, if you filter by, you fetch it as well
 *
 */
export interface UserWithAllFilters {
  id?: string | string[];

  attributes?: string[];

  limit?: number;
}

@Scopes(() => ({
  [UserScope.WithAll]: ({
    id,
    attributes,

    limit,
  }: UserWithAllFilters = {}) => {
    const findOptions: {
      where: WhereOptions;
      include?: Includeable[];
      attributes?: string[];
      limit?: number;
    } = {
      where: {
        ...(id && { id }),
      },
      include: [],
      attributes: attributes,
      limit: limit,
    };

    return findOptions;
  },
}))
@Table({
  modelName: 'User',
  timestamps: true,
  paranoid: true,
  tableName: 'User',
})
export default class User extends Model<User, Partial<User>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.STRING, allowNull: true, unique: true })
  declare email: string | null;

  /** bcrypt hash; never returned from the API (see LoginService). */
  @Column({ type: DataType.STRING, allowNull: true })
  declare passwordHash: string | null;

  @Column({
    type: DataType.ENUM(...Object.values(Role)),
    allowNull: false,
    defaultValue: Role.USER,
  })
  declare role: Role;

  /** SD-39: TOTP secret, AES-256-GCM encrypted (SecretBox). */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare mfaSecretEnc: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare mfaEnabledAt: Date | null;

  /** SHA-256 hashes of single-use recovery codes. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare mfaRecoveryCodes: string[] | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  @DeletedAt
  declare deletedAt: Date | null;
}

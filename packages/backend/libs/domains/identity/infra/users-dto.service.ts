import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import User, { UserScope, UserWithAllFilters } from './models/user.model';
import { Op, QueryTypes, Sequelize, Transaction } from 'sequelize';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { Fatal_NotFoundError } from '@app/common/errors';

@Injectable()
export class UsersDtoService {
  private readonly l = new Logger(UsersDtoService.name);

  constructor(
    @InjectModel(User) private readonly userModel: typeof User,
    @InjectConnection() private readonly sequelizeInstance: Sequelize,
  ) {}

  public countAll(
    params?: UserWithAllFilters,
    tx?: Transaction,
  ): Promise<number> {
    return this.userModel
      .scope({
        method: [UserScope.WithAll, <UserWithAllFilters>params],
      })
      .count({ transaction: tx });
  }

  public findAll(
    params?: UserWithAllFilters,
    tx?: Transaction,
  ): Promise<User[]> {
    return this.userModel
      .scope({
        method: [UserScope.WithAll, <UserWithAllFilters>params],
      })
      .findAll({
        transaction: tx,
      });
  }

  public findOne(
    params?: UserWithAllFilters,
    tx?: Transaction,
  ): Promise<User | null> {
    return this.userModel
      .scope({
        method: [UserScope.WithAll, <UserWithAllFilters>params],
      })
      .findOne({
        transaction: tx,
      });
  }

  public async requestUser({
    params,
    tx,
    additors,
  }: {
    params: UserWithAllFilters;
    tx: Transaction;
    additors?: { type: 'stub' }[];
  }): Promise<User> {
    const processedParams = params;
    if (additors) {
      const additorsList = Array.isArray(additors) ? additors : [additors];

      for (const additor of additorsList) {
        switch (additor.type) {
          case 'stub':
            break;
          default:
            throw new BadRequestException('Invalid additor type');
        }
      }
    }

    const rawUsers = await this.findAll(processedParams, tx);

    const user = rawUsers[0];

    if (!user) {
      throw new Fatal_NotFoundError({
        detail: `User ${params.id} not found`,
        title: 'User not found',
      });
    }

    return user;
  }

  public async update(
    params: Partial<User>,
    id: string,
    tx?: Transaction,
  ): Promise<User> {
    const [_, [user]] = await this.userModel.update(params, {
      where: { id },
      transaction: tx,
      returning: true,
    });

    if (_ === 0) {
      throw new Fatal_NotFoundError({
        detail: 'User not found',
        title: 'User not found',
      });
    }

    if (!user) {
      throw new Fatal_NotFoundError({
        detail: 'User not found',
        title: 'User not found',
      });
    }

    return user;
  }
}

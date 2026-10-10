import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CreationAttributes } from 'sequelize';
import {
  CreateBisOrderDto,
  BisOrderModel as BisOrder,
} from '@app/domains/orders';
import Outbox from '@app/infrastructure/outbox/outbox.model';
import { UserModel as User, CreateUserDto } from '@app/domains/identity';
import { ProductModel as Product } from '@app/domains/catalog';
import { CreateOutboxDto } from '@app/infrastructure/outbox/types';

export type SqlModelClass = User | BisOrder | Outbox | Product;

export type SqlModel =
  typeof User | typeof BisOrder | typeof Outbox | typeof Product;

export enum TableName {
  User = 'User',
  BisOrder = 'BisOrder',
  Outbox = 'Outbox',
  Product = 'Product',
}

export enum DBRelation {
  belongsTo = 'belongsTo',
  hasMany = 'hasMany',
  belongsToMany = 'belongsToMany',
}

export interface RelationData {
  model: SqlModel;
  through?: SqlModel;
  foreignKey: string;
  relationType: DBRelation;
}

export interface TableData<
  DbModelType extends SqlModel = typeof User,
  DbModel extends SqlModelClass = User,
> {
  sqlModel: DbModelType;
  defaults: {
    [key in keyof CreationAttributes<DbModel>]: any | (() => any);
  };
  relations: {
    [relation in Exclude<string, 'sqlModel'>]: RelationData;
  };
}

export type Schema = {
  User: TableData<typeof User, User>;
  BisOrder: TableData<typeof BisOrder, BisOrder>;
  Outbox: TableData<typeof Outbox, Outbox>;
  Product: TableData<typeof Product, Product>;
};

export class CreateTreelikeUserDto extends PartialType(CreateUserDto) {
  @ApiProperty()
  __type__: TableName.User | 'GET_FROM_PARENT';

  @ApiProperty()
  deletedAt?: Date;
}

export class CreateTreelikeBisOrderDto extends PartialType(CreateBisOrderDto) {
  @ApiProperty()
  __type__: TableName.BisOrder | 'GET_FROM_PARENT';

  @Type(() => CreateTreelikeUserDto)
  @ApiProperty({ type: () => CreateTreelikeUserDto, isArray: true })
  user?: CreateTreelikeUserDto[];
}

export class CreateTreelikeOutboxDto extends PartialType(CreateOutboxDto) {
  @ApiProperty()
  __type__: TableName.Outbox | 'GET_FROM_PARENT';
}

/**
 * Showcase tables (docs/showcase) use a lightweight fixture shape instead of
 * a full DTO class per table: any subset of the model's creation attributes
 * plus nested relations by name.
 */
export type CreateTreelikeFixture<
  M extends SqlModelClass,
  T extends TableName,
> = Partial<CreationAttributes<M>> & {
  __type__: T | 'GET_FROM_PARENT';
  [relation: string]: unknown;
};

export type CreateTreelikeProductDto = CreateTreelikeFixture<
  Product,
  TableName.Product
>;

export type CreateTreelikeClass =
  | CreateTreelikeProductDto
  | CreateTreelikeUserDto
  | CreateTreelikeBisOrderDto
  | CreateTreelikeOutboxDto;

export interface CreateTreelikeOptions {
  argDepth?: number;
  reparse?: boolean;
}

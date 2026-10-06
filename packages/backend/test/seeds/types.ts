import { ApiProperty, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CreationAttributes } from 'sequelize';
import { CreateBisOrderDto, BisOrderModel as BisOrder } from '@app/domains/orders';
import { CreateLedgerEntryDto, LedgerEntryModel as LedgerEntry, PaymentModel as Payment, CreatePaymentDto } from '@app/domains/payments';
import Outbox from '@app/infrastructure/outbox/outbox.model';
import { UserModel as User, CreateUserDto } from '@app/domains/identity';
import { ProductModel as Product } from '@app/domains/catalog';
import { CreateOutboxDto } from '@app/infrastructure/outbox/types';

export type SqlModelClass =
  | User
  | BisOrder
  | Payment
  | LedgerEntry
  | Outbox
  | Product;

export type SqlModel =
  | typeof User
  | typeof BisOrder
  | typeof Payment
  | typeof LedgerEntry
  | typeof Outbox
  | typeof Product;

export enum TableName {
  User = 'User',
  BisOrder = 'BisOrder',
  Payment = 'Payment',
  LedgerEntry = 'LedgerEntry',
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
  Payment: TableData<typeof Payment, Payment>;
  LedgerEntry: TableData<typeof LedgerEntry, LedgerEntry>;
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

  @Type(() => CreateTreelikePaymentDto)
  @ApiProperty({ type: () => CreateTreelikePaymentDto, isArray: true })
  payments?: CreateTreelikePaymentDto[];
}

export class CreateTreelikePaymentDto extends PartialType(CreatePaymentDto) {
  @ApiProperty()
  __type__: TableName.Payment | 'GET_FROM_PARENT';

  @Type(() => CreateTreelikeBisOrderDto)
  @ApiProperty({ type: () => CreateTreelikeBisOrderDto, isArray: true })
  bisOrder?: CreateTreelikeBisOrderDto[];

  @Type(() => CreateTreelikeLedgerEntryDto)
  @ApiProperty({ type: () => CreateTreelikeLedgerEntryDto, isArray: true })
  ledgerEntries?: CreateTreelikeLedgerEntryDto[];
}

export class CreateTreelikeLedgerEntryDto extends PartialType(CreateLedgerEntryDto) {
  @ApiProperty()
  __type__: TableName.LedgerEntry | 'GET_FROM_PARENT';

  @Type(() => CreateTreelikePaymentDto)
  @ApiProperty({ type: () => CreateTreelikePaymentDto, isArray: true })
  payment?: CreateTreelikePaymentDto[];
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
export type CreateTreelikeFixture<M extends SqlModelClass, T extends TableName> = Partial<CreationAttributes<M>> & {
  __type__: T | 'GET_FROM_PARENT';
  [relation: string]: unknown;
};

export type CreateTreelikeProductDto = CreateTreelikeFixture<Product, TableName.Product>;

export type CreateTreelikeClass =
  | CreateTreelikeProductDto
  | CreateTreelikeUserDto
  | CreateTreelikeBisOrderDto
  | CreateTreelikePaymentDto
  | CreateTreelikeLedgerEntryDto
  | CreateTreelikeOutboxDto;

export interface CreateTreelikeOptions {
  argDepth?: number;
  reparse?: boolean;
}

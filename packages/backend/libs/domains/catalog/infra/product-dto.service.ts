import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Transaction } from 'sequelize';
import { InjectModel } from '@nestjs/sequelize';
import { Fatal_NotFoundError } from '@app/common/errors';
import Product, {
  ProductScope,
  ProductWithAllFilters,
} from './models/product.model';

@Injectable()
export class ProductDtoService {
  private readonly l = new Logger(ProductDtoService.name);

  constructor(
    @InjectModel(Product) private readonly productModel: typeof Product,
  ) {}

  public countAll(
    params?: ProductWithAllFilters,
    tx?: Transaction,
  ): Promise<number> {
    return this.productModel
      .scope({
        method: [ProductScope.WithAll, <ProductWithAllFilters>params],
      })
      .count({ transaction: tx });
  }

  public findAll(
    params?: ProductWithAllFilters,
    tx?: Transaction,
  ): Promise<Product[]> {
    return this.productModel
      .scope({
        method: [ProductScope.WithAll, <ProductWithAllFilters>params],
      })
      .findAll({
        transaction: tx,
      });
  }

  public findOne(
    params?: ProductWithAllFilters,
    tx?: Transaction,
  ): Promise<Product | null> {
    return this.productModel
      .scope({
        method: [ProductScope.WithAll, <ProductWithAllFilters>params],
      })
      .findOne({
        transaction: tx,
      });
  }

  public async requestProduct({
    params,
    tx,
    additors,
  }: {
    params: ProductWithAllFilters;
    tx?: Transaction;
    additors?: { type: 'stub' }[];
  }): Promise<Product> {
    if (additors) {
      for (const additor of additors) {
        switch (additor.type) {
          case 'stub':
            break;
          default:
            throw new BadRequestException('Invalid additor type');
        }
      }
    }

    const product = await this.findOne(params, tx);

    if (!product) {
      throw new Fatal_NotFoundError({
        detail: `Product ${params.id} not found`,
        title: 'Product not found',
      });
    }

    return product;
  }

  public async requestProducts({
    params,
    tx,
  }: {
    params: ProductWithAllFilters;
    tx?: Transaction;
  }): Promise<Product[]> {
    return this.findAll(params, tx);
  }

  public async create({
    params,
    tx,
  }: {
    params: Partial<Product>;
    tx?: Transaction;
  }): Promise<Product> {
    return await this.productModel.create(params, { transaction: tx });
  }

  public async update({
    params,
    id,
    tx,
  }: {
    params: Partial<Product>;
    id: string;
    tx?: Transaction;
  }): Promise<Product> {
    const [count, [product]] = await this.productModel.update(params, {
      where: { id },
      transaction: tx,
      returning: true,
    });

    if (count === 0 || !product) {
      throw new Fatal_NotFoundError({
        detail: 'Product is not updated',
        title: 'Product is not updated',
      });
    }

    return product;
  }
}

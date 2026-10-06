import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Transaction, WhereOptions } from 'sequelize';
import { InjectModel } from '@nestjs/sequelize';
import { Fatal_NotFoundError } from '@app/common/errors/error.types';
import Payment, { PaymentScope, PaymentWithAllFilters } from './models/payment.model';

@Injectable()
export class PaymentDtoService {
  private readonly l = new Logger(PaymentDtoService.name);

  constructor(
    @InjectModel(Payment) private readonly paymentModel: typeof Payment,
  ) { }

  public countAll(
    params?: PaymentWithAllFilters,
    tx?: Transaction,
  ): Promise<number> {
    return this.paymentModel
      .scope({
        method: [PaymentScope.WithAll, <PaymentWithAllFilters>params],
      })
      .count({ transaction: tx });
  }

  public findAll(
    params?: PaymentWithAllFilters,
    tx?: Transaction,
  ): Promise<Payment[]> {
    return this.paymentModel
      .scope({
        method: [PaymentScope.WithAll, <PaymentWithAllFilters>params],
      })
      .findAll({
        transaction: tx,
      });
  }

  public findOne(
    params?: PaymentWithAllFilters,
    tx?: Transaction,
  ): Promise<Payment | null> {
    return this.paymentModel
      .scope({
        method: [PaymentScope.WithAll, <PaymentWithAllFilters>params],
      })
      .findOne({
        transaction: tx,
      });
  }


  public async requestPaymentOptional({
    params,
    tx,
    additors,
  }: {
    params: PaymentWithAllFilters;
    tx: Transaction;
    additors?: { type: 'stub' }[];
  }): Promise<Payment | null> {
    try {
      return await this.requestPayment({ params, tx, additors });
    } catch (error) {
      if (error instanceof Fatal_NotFoundError) {
        return null;
      }
      throw error;
    }
  }

  public async requestPayment({
    params,
    tx,
    additors,
  }: {
    params: PaymentWithAllFilters;
    tx: Transaction;
    additors?: { type: 'stub' }[];
  }): Promise<Payment> {
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

    const rawPayments = await this.findOne(processedParams, tx);

    if (!rawPayments) {
      throw new Fatal_NotFoundError({ detail: `Payment ${params.id} not found`, title: 'Payment not found' });
    }

    return rawPayments;
  }

  public async requestPayments({
    params,
    tx,
    additors,
  }: {
    params: PaymentWithAllFilters;
    tx: Transaction;
    additors?: { type: 'stub' }[];
  }): Promise<Payment[]> {
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

    const rawPayments = await this.findAll(processedParams, tx);

    return rawPayments;
  }

  public async create({
    params,
    tx,
  }: {
    params: Partial<Payment>;
    tx: Transaction;
  }): Promise<Payment> {
    return await this.paymentModel.create(params, { transaction: tx });
  }

  public async update({
    params,
    where,
    tx,
  }: {
    params: Partial<Payment>;
    where: WhereOptions<Payment>;
    tx: Transaction;
  }): Promise<Payment> {
    const [_, [payment]] = await this.paymentModel.update(params, {
      where,
      transaction: tx,
      returning: true,
    });

    if (_ === 0) {
      throw new Fatal_NotFoundError({ detail: 'Payment is not updated', title: 'Payment is not updated' });
    }

    if (!payment) {
      throw new Fatal_NotFoundError({ detail: 'Payment is not updated', title: 'Payment is not updated' });
    }

    return payment;
  }
}

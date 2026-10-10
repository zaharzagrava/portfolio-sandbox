import { Injectable } from '@nestjs/common';
import { DbUtilsService } from '@app/infrastructure/database/db-utils/db-utils.service';
import { PaymentDtoService } from '@app/domains/payments';
import type { AuthenticatedUser } from '@app/domains/identity';
import { ListPaymentsResponseDto, PaymentRawDto } from './types';

@Injectable()
export class PaymentQueryService {
  constructor(
    private readonly dbUtilsService: DbUtilsService,
    private readonly paymentDtoService: PaymentDtoService,
  ) {}

  public async getPayment({
    id,
    viewerUser,
  }: {
    id: string;
    viewerUser: AuthenticatedUser;
  }): Promise<PaymentRawDto> {
    return await this.dbUtilsService.wrapInTransaction(async (tx) => {
      return await this.paymentDtoService.requestPayment({
        params: {
          id,
          bisOrderFilters: { userId: viewerUser.id },
          // INNER join - with a LEFT join the userId filter only nulls out
          // `bisOrder` and other users' payments would still be returned
          bisOrderRequired: true,
        },
        tx,
      });
    });
  }

  public async getPaymentByIdempotencyKey({
    idempotencyKey,
    viewerUser,
  }: {
    idempotencyKey: string;
    viewerUser: AuthenticatedUser;
  }): Promise<PaymentRawDto> {
    return await this.dbUtilsService.wrapInTransaction(async (tx) => {
      return await this.paymentDtoService.requestPayment({
        params: {
          idempotencyKey,
          bisOrderFilters: { userId: viewerUser.id },
          bisOrderRequired: true,
        },
        tx,
      });
    });
  }

  public async listPayments({
    viewerUser,
  }: {
    viewerUser: AuthenticatedUser;
  }): Promise<ListPaymentsResponseDto> {
    return await this.dbUtilsService.wrapInTransaction(async (tx) => {
      const payments = await this.paymentDtoService.requestPayments({
        params: {
          bisOrderFilters: { userId: viewerUser.id },
          bisOrderRequired: true,
        },
        tx,
      });

      return { payments };
    });
  }
}

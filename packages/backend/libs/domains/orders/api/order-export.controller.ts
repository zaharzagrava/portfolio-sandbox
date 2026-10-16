import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  orderExportCreateRequestSchema,
  orderExportListQuerySchema,
  type OrderExport,
  type OrderExportDownload,
  type OrderExportListQuery,
  type OrderExportPage,
} from '@marketplace-sandbox/contracts';
import { User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { OrderExportCommandService } from '../application/order-export-command.service';
import { OrderExportQueryService } from '../application/order-export-query.service';
import { ExportUuidPipe, ExportZodPipe } from './order-export-pipes';

const createBody = new ExportZodPipe(orderExportCreateRequestSchema);
const listQuery = new ExportZodPipe(orderExportListQuerySchema);

/**
 * The shop's order exports (S12 contracts/http.md). Thin: a validated input, one application call, the contract shape
 * back. The shop comes from the path; the guard checks the membership and `orders.manage`; another shop's export is
 * `export_not_found`.
 */
@ApiTags('order-exports')
@Controller('shops/:shopId/order-exports')
export class OrderExportController {
  constructor(
    private readonly commands: OrderExportCommandService,
    private readonly queries: OrderExportQueryService,
  ) {}

  @ShopScoped('orders.manage')
  @RateLimit('orders.export-start.shop')
  @Idempotent()
  @HttpCode(HttpStatus.ACCEPTED)
  @Post()
  async start(
    @Param('shopId', ExportUuidPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body(createBody) _body: Record<string, never>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderExport> {
    const created = await this.commands.start(shopId, user.id);
    res.setHeader(
      'Location',
      `/api/shops/${shopId}/order-exports/${created.exportId}`,
    );
    return created;
  }

  @ShopScoped('orders.manage')
  @Get()
  list(
    @Param('shopId', ExportUuidPipe) shopId: string,
    @Query(listQuery) query: OrderExportListQuery,
  ): Promise<OrderExportPage> {
    return this.queries.list(shopId, query);
  }

  @ShopScoped('orders.manage')
  @Get(':exportId')
  get(
    @Param('shopId', ExportUuidPipe) shopId: string,
    @Param('exportId', ExportUuidPipe) exportId: string,
  ): Promise<OrderExport> {
    return this.queries.get(shopId, exportId);
  }

  @ShopScoped('orders.manage')
  @HttpCode(HttpStatus.OK)
  @Post(':exportId/cancel')
  cancel(
    @Param('shopId', ExportUuidPipe) shopId: string,
    @Param('exportId', ExportUuidPipe) exportId: string,
    @User() user: AuthenticatedUser,
  ): Promise<OrderExport> {
    return this.commands.cancel(shopId, exportId, user.id);
  }

  @ShopScoped('orders.manage')
  @Get(':exportId/download')
  download(
    @Param('shopId', ExportUuidPipe) shopId: string,
    @Param('exportId', ExportUuidPipe) exportId: string,
    @User() user: AuthenticatedUser,
  ): Promise<OrderExportDownload> {
    return this.commands.download(shopId, exportId, user.id);
  }
}

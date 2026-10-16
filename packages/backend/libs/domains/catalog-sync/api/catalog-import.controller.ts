import {
  Body,
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  NestInterceptor,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';
import {
  importCompleteRequestSchema,
  importListQuerySchema,
  importStartRequestSchema,
  type ImportCompleteRequest,
  type ImportErrorReport,
  type ImportJob,
  type ImportListQuery,
  type ImportPage,
  type ImportStartRequest,
  type ImportStartResponse,
  type ImportUploadState,
} from '@marketplace-sandbox/contracts';
import { User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { Idempotent } from '@app/infrastructure/idempotency';
import { ImportQueryService } from '../application/import-query.service';
import {
  ImportStartService,
  type CompleteResult,
} from '../application/import-start.service';
import { ImportUuidPipe, ImportZodPipe } from './import-pipes';

const startBody = new ImportZodPipe(importStartRequestSchema);
const completeBody = new ImportZodPipe(importCompleteRequestSchema);
const listQuery = new ImportZodPipe(importListQuerySchema);

/**
 * `complete` answers `202` + `Location` for the call that won the transition and `200` for a replay (S07 D-12): the
 * service says which in `created`, this maps it to the response, so the controller itself never branches on state.
 */
@Injectable()
export class ImportCompleteResponseInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ImportJob> {
    const res = context.switchToHttp().getResponse<Response>();
    const req = context
      .switchToHttp()
      .getRequest<{ params: Record<string, string> }>();
    return next.handle().pipe(
      map((result: CompleteResult) => {
        if (result.created) {
          res.status(HttpStatus.ACCEPTED);
          res.setHeader(
            'Location',
            `/api/shops/${req.params.shopId}/imports/${req.params.importId}`,
          );
        } else res.status(HttpStatus.OK);
        return result.job;
      }),
    );
  }
}

/**
 * The shop's bulk imports (S07 contracts/http-api.md). Thin: a validated input, one application call, the contract shape
 * back. The shop comes from the path; the guard checks the membership, the permission and the shop status; another
 * shop's import is `import_not_found`. The start limit is charged by the service, in code, so it holds in every app.
 */
@ApiTags('catalog-import')
@Controller('shops/:shopId/imports')
export class CatalogImportController {
  constructor(
    private readonly starts: ImportStartService,
    private readonly queries: ImportQueryService,
  ) {}

  @ShopScoped('products.write')
  @Idempotent()
  @Post()
  start(
    @Param('shopId', ImportUuidPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body(startBody) body: ImportStartRequest,
  ): Promise<ImportStartResponse> {
    return this.starts.start(shopId, user.id, body);
  }

  // read routes use `shop.read`: every member role holds it and a SUSPENDED or DELETING shop still answers (AS-63)
  @ShopScoped('shop.read')
  @Get()
  list(
    @Param('shopId', ImportUuidPipe) shopId: string,
    @Query(listQuery) query: ImportListQuery,
  ): Promise<ImportPage> {
    return this.queries.list(shopId, query);
  }

  @ShopScoped('shop.read')
  @Get(':importId')
  status(
    @Param('shopId', ImportUuidPipe) shopId: string,
    @Param('importId', ImportUuidPipe) importId: string,
  ): Promise<ImportJob> {
    return this.queries.status(shopId, importId);
  }

  @ShopScoped('products.write')
  @Get(':importId/upload')
  upload(
    @Param('shopId', ImportUuidPipe) shopId: string,
    @Param('importId', ImportUuidPipe) importId: string,
  ): Promise<ImportUploadState> {
    return this.starts.uploadState(shopId, importId);
  }

  @ShopScoped('products.write')
  @UseInterceptors(ImportCompleteResponseInterceptor)
  @Post(':importId/complete')
  complete(
    @Param('shopId', ImportUuidPipe) shopId: string,
    @Param('importId', ImportUuidPipe) importId: string,
    @Body(completeBody) body: ImportCompleteRequest,
  ): Promise<CompleteResult> {
    return this.starts.complete(shopId, importId, body);
  }

  @ShopScoped('products.write')
  @HttpCode(HttpStatus.OK)
  @Post(':importId/cancel')
  cancel(
    @Param('shopId', ImportUuidPipe) shopId: string,
    @Param('importId', ImportUuidPipe) importId: string,
    @User() user: AuthenticatedUser,
  ): Promise<ImportJob> {
    return this.starts.cancel(shopId, importId, user.id);
  }

  @ShopScoped('shop.read')
  @Get(':importId/error-report')
  errorReport(
    @Param('shopId', ImportUuidPipe) shopId: string,
    @Param('importId', ImportUuidPipe) importId: string,
  ): Promise<ImportErrorReport> {
    return this.queries.errorReport(shopId, importId);
  }
}

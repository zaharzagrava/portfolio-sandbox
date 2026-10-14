import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  knowledgeCreateRequestSchema,
  knowledgeListQuerySchema,
  type KnowledgeCreateRequest,
  type KnowledgeCreateResponse,
  type KnowledgeDocument,
  type KnowledgeDocumentPage,
  type KnowledgeListQuery,
} from '@marketplace-sandbox/contracts';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { DocumentService } from '../application/document.service';
import { KnowledgeZodPipe, ValidatedRequest } from './knowledge-validation';

/** Plain aliases: a `z.output<...>` parameter type would make the global ValidationPipe try to instantiate it. */
type ListQuery = KnowledgeListQuery;

/** A shop's knowledge documents (S47 FR-001 – FR-010). Bodies and queries are parsed with the shared contract schemas. */
@ApiTags('knowledge')
@Controller('shops/:shopId/knowledge/documents')
export class KnowledgeDocumentsController {
  constructor(private readonly documents: DocumentService) {}

  @UseGuards(ValidatedRequest({ body: knowledgeCreateRequestSchema }))
  @ShopScoped('products.write')
  @RateLimit('rag.ingest')
  @Post()
  async create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: UserRawDto,
    @Body() body: KnowledgeCreateRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KnowledgeCreateResponse> {
    const { created, ...answer } = await this.documents.create(
      { kind: 'shop', shopId },
      user.id,
      body,
    );
    res.status(created ? 201 : 200);
    return answer;
  }

  @ShopScoped('products.write')
  @RateLimit('rag.ingest')
  @HttpCode(200)
  @Post(':documentId/uploaded')
  uploaded(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<KnowledgeDocument> {
    return this.documents.uploaded({ kind: 'shop', shopId }, documentId);
  }

  @ShopScoped('products.write')
  @HttpCode(202)
  @Post(':documentId/retry')
  retry(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<KnowledgeDocument> {
    return this.documents.retry({ kind: 'shop', shopId }, documentId);
  }

  // `shop.read`, not `products.read`: S03's status gate lets a SUSPENDED shop keep only `shop.read` (S47 AS-19: list and get
  // stay 200 there). Every role that holds `products.read` holds `shop.read` too.
  @ShopScoped('shop.read')
  @Get()
  list(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query(new KnowledgeZodPipe(knowledgeListQuerySchema)) query: ListQuery,
  ): Promise<KnowledgeDocumentPage> {
    return this.documents.list({ kind: 'shop', shopId }, query);
  }

  @ShopScoped('shop.read')
  @Get(':documentId')
  get(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<KnowledgeDocument> {
    return this.documents.get({ kind: 'shop', shopId }, documentId);
  }

  @ShopScoped('products.write')
  @HttpCode(204)
  @Delete(':documentId')
  async remove(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<void> {
    await this.documents.remove({ kind: 'shop', shopId }, documentId);
  }
}

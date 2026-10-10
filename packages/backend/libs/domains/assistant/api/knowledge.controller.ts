import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type { Request, Response } from 'express';
import { Firewall, User, UserRawDto, Role } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { KnowledgeService } from '../application/knowledge.service';
import { AnswerService } from '../application/answer.service';

export class CreateKnowledgeDocumentDto {
  @ApiProperty() @IsString() @Length(1, 200) title: string;
  @ApiProperty({ enum: ['PUBLIC', 'SHOP_PRIVATE'] })
  @IsIn(['PUBLIC', 'SHOP_PRIVATE'])
  visibility: 'PUBLIC' | 'SHOP_PRIVATE';
  @ApiPropertyOptional({ description: 'Attach to one product (public only)' })
  @IsOptional()
  @IsUUID()
  productId?: string;
  @ApiPropertyOptional({ description: 'Markdown body (inline upload)' })
  @IsOptional()
  @IsString()
  markdown?: string;
  @ApiPropertyOptional({
    description:
      'PDF: SHA-256 hex of the file; the response carries a presigned PUT pinned to it',
  })
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  pdfSha256?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20 * 1024 * 1024)
  pdfSize?: number;
}

export class CreatePlatformDocumentDto {
  @ApiProperty() @IsString() @Length(1, 200) title: string;
  @ApiProperty() @IsString() markdown: string;
}

export class AskDto {
  @ApiProperty() @IsString() @Length(3, 500) question: string;
}

@ApiTags('knowledge')
@Controller()
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly answers: AnswerService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/knowledge/documents')
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: UserRawDto,
    @Body() body: CreateKnowledgeDocumentDto,
  ) {
    const doc = {
      shopId,
      productId: body.productId ?? null,
      visibility: body.visibility,
      title: body.title,
      createdBy: user.id,
    };
    if (body.markdown !== undefined)
      return this.knowledge.createMarkdown(doc, body.markdown);
    if (body.pdfSha256 && body.pdfSize)
      return this.knowledge.createPdf(doc, body.pdfSha256, body.pdfSize);
    throw new BadRequestException('Provide markdown, or pdfSha256 + pdfSize');
  }

  @ShopScoped('products.write')
  @HttpCode(200)
  @Post('shops/:shopId/knowledge/documents/:documentId/uploaded')
  uploaded(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.knowledge.uploaded(shopId, documentId);
  }

  @ShopScoped('products.read')
  @Get('shops/:shopId/knowledge/documents')
  list(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.knowledge.list(shopId);
  }

  @ShopScoped('products.write')
  @HttpCode(204)
  @Delete('shops/:shopId/knowledge/documents/:documentId')
  async remove(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    await this.knowledge.delete(shopId, documentId);
  }

  /** Seller help center articles (platform-wide, every shop's assistant can cite them). */
  @Firewall({ roles: [Role.ADMIN] })
  @Post('admin/knowledge/documents')
  createPlatform(
    @User() user: UserRawDto,
    @Body() body: CreatePlatformDocumentDto,
  ) {
    return this.knowledge.createMarkdown(
      {
        shopId: null,
        visibility: 'PLATFORM',
        title: body.title,
        createdBy: user.id,
      },
      body.markdown,
    );
  }

  /** "Ask this product" (buyers, anonymous allowed) → text/event-stream: sources → text… → done {citations} | not_found. */
  @Firewall({ anonymous: true })
  @RateLimit('rag.ask')
  @Post('products/:productId/ask')
  async askProduct(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() body: AskDto,
    @Req() req: Request & { user?: { id: string } },
    @Res() res: Response,
  ) {
    const [product] = await this.sequelize.query<{ shopId: string | null }>(
      `SELECT "shopId" FROM "Product" WHERE id = :productId`,
      { type: QueryTypes.SELECT, replacements: { productId } },
    );
    if (!product?.shopId) throw new NotFoundException('Product not found');
    await this.answers.stream(
      { kind: 'product', productId, shopId: product.shopId },
      body.question,
      req.user?.id ?? null,
      req,
      res,
    );
  }

  /** Seller help center: platform articles + this shop's own (incl. private) documents. */
  @ShopScoped('shop.read')
  @RateLimit('rag.ask')
  @Post('shops/:shopId/knowledge/ask')
  async askShop(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: AskDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.answers.stream(
      { kind: 'shop', shopId },
      body.question,
      shopId,
      req,
      res,
    );
  }
}

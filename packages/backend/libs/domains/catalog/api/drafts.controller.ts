import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { DraftsService } from '../application/drafts.service';

export class CreateDraftDto {
  @ApiProperty() @IsString() @Length(1, 120) title: string;
  @ApiPropertyOptional({ description: 'Edit an existing product: the draft starts from its current content' }) @IsOptional() @IsUUID() productId?: string;
}

export class VersionDto {
  @ApiProperty() @IsString() @Length(1, 80) name: string;
}

@ApiTags('drafts')
@Controller('shops/:shopId/drafts')
export class DraftsController {
  constructor(private readonly drafts: DraftsService) {}

  @ShopScoped('products.write')
  @Post()
  create(@Param('shopId', ParseUUIDPipe) shopId: string, @User() user: UserRawDto, @Body() body: CreateDraftDto) {
    return this.drafts.create(shopId, user.id, body.title, body.productId);
  }

  @ShopScoped('products.read')
  @Get()
  list(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.drafts.list(shopId);
  }

  /** → { url: "wss://collab-7.../collab/<id>", ticket, canWrite }: the editor opens the WebSocket with `?ticket=`. */
  @Firewall()
  @Post(':draftId/connect')
  async connect(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('draftId', ParseUUIDPipe) draftId: string, @User() user: UserRawDto) {
    await this.drafts.assertShop(draftId, shopId);
    return this.drafts.connect(draftId, user.id);
  }

  @ShopScoped('products.read')
  @Get(':draftId/versions')
  async versions(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('draftId', ParseUUIDPipe) draftId: string) {
    await this.drafts.assertShop(draftId, shopId);
    return this.drafts.versions(draftId);
  }

  @ShopScoped('products.write')
  @Post(':draftId/versions')
  async createVersion(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('draftId', ParseUUIDPipe) draftId: string, @User() user: UserRawDto, @Body() body: VersionDto) {
    await this.drafts.assertShop(draftId, shopId);
    return this.drafts.createVersion(draftId, user.id, body.name);
  }

  @ShopScoped('products.write')
  @Post(':draftId/publish')
  async publish(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('draftId', ParseUUIDPipe) draftId: string, @User() user: UserRawDto) {
    await this.drafts.assertShop(draftId, shopId);
    return this.drafts.publish(draftId, user.id);
  }
}

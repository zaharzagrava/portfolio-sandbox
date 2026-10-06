import { Controller, Get, Headers, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ProductPageService } from './product-page.service';

/** REST aggregate for the web app (Next.js server components call it in FE phase 2). */
@ApiTags('bff')
@Controller('bff')
export class BffController {
  constructor(private readonly pages: ProductPageService) {}

  @Get('product-page/:id')
  productPage(@Param('id', ParseUUIDPipe) id: string, @Headers('authorization') auth?: string) {
    return this.pages.load(id, auth);
  }
}

import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { buildOpenApi } from '../application/openapi.builder';

/** `GET /v1/openapi.json` (apps/public-api): the description of the contract, without authentication and without a key in it. */
@ApiExcludeController()
@Controller('v1')
export class PublicOpenApiController {
  @Get('openapi.json')
  @Header('Cache-Control', 'public, max-age=60')
  description() {
    return buildOpenApi();
  }
}

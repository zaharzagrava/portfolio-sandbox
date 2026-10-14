import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { buildOpenApi } from '../application/openapi.builder';

/** `GET /api/developers/openapi.json` (apps/core): the same document, same origin as the dashboard (W07 follow-up). */
@ApiExcludeController()
@Controller('developers')
export class DashboardOpenApiController {
  @Get('openapi.json')
  @Header('Cache-Control', 'public, max-age=60')
  description() {
    return buildOpenApi();
  }
}

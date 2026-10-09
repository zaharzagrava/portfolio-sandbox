import './instrument';
import { NestFactory } from '@nestjs/core';
import { ApiConfigService } from '@app/common/config';
import { configureHttpApp } from '@app/infrastructure/platform';
import { BffAppModule } from './bff-app.module';

async function bootstrap() {
  const app = await NestFactory.create(BffAppModule, { bufferLogs: true });
  configureHttpApp(app); // REST under /api/bff/*, GraphQL at /api/graphql
  await app.listen(app.get(ApiConfigService).get('port'));
}

bootstrap();

import './instrument';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiConfigService } from '@app/common/config';
import { configureHttpApp } from '@app/infrastructure/platform';
import { publicApiRequestContext } from '@app/domains/developer-platform';
import { PublicApiAppModule } from './public-api-app.module';

async function bootstrap() {
  const app = await NestFactory.create(PublicApiAppModule, {
    bufferLogs: true,
  });
  // server-to-server: no origin is ever granted, a browser preflight is answered like any unknown method (S42 AS-69)
  configureHttpApp(app, {
    globalPrefix: false,
    cors: false,
    beforeBodyParsing: [publicApiRequestContext(app)],
  });
  // OpenAPI is the contract (and the source for SDK generation).
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Marketplace API')
      .setVersion('v1')
      .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        description: 'sk_live_… / sk_test_…',
      })
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
  await app.listen(app.get(ApiConfigService).get('port'));
}

bootstrap();

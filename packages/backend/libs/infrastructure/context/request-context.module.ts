import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import type { Request } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { RequestContext } from './request-context.service';
import { REQUEST_ID_HEADER } from '@app/common/request-context/types';
import { enableSequelizeCls } from './sequelize-cls';

enableSequelizeCls();

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Mounts the CLS middleware for every HTTP request and seeds `requestId`
 * (honouring a well-formed upstream `x-request-id`, e.g. from the edge worker,
 * so one ID follows the request across services).
 */
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: Request) => {
          const incoming = req.headers[REQUEST_ID_HEADER];
          return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : uuidv7();
        },
        setup: (cls, req: Request, res) => {
          cls.set('requestId', cls.getId());
          cls.set('principalType', 'anonymous');
          res.setHeader(REQUEST_ID_HEADER, cls.getId());
        },
      },
    }),
  ],
  providers: [RequestContext],
  exports: [RequestContext],
})
export class RequestContextModule {}

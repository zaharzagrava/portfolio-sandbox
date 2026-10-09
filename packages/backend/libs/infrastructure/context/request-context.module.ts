import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import type { Request } from 'express';
import { RequestContext } from './request-context.service';
import { REQUEST_ID_HEADER } from '@app/common/request-context/types';
import { enableSequelizeCls } from './sequelize-cls';
import { resolveRequestId } from './request-id';

enableSequelizeCls();

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
        idGenerator: (req: Request) =>
          resolveRequestId(req.headers[REQUEST_ID_HEADER]),
        setup: (cls, req: Request, res) => {
          cls.set('requestId', cls.getId());
          const traceparent = req.headers['traceparent'];
          if (typeof traceparent === 'string')
            cls.set('traceparent', traceparent);
          cls.set('principalType', 'anonymous');
          // Resolved by the bootstrap (trusted-proxy aware); falls back to the peer when no bootstrap ran.
          cls.set(
            'clientIp',
            (req as Request & { clientIp?: string }).clientIp ?? req.ip,
          );
          res.setHeader(REQUEST_ID_HEADER, cls.getId());
        },
      },
    }),
  ],
  providers: [RequestContext],
  exports: [RequestContext],
})
export class RequestContextModule {}

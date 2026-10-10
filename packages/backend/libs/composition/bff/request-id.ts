import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '@app/common/request-context/types';

/** The id of the request in flight (set at the edge by the platform's request context); `undefined` outside a request. */
@Injectable()
export class CurrentRequest {
  constructor(private readonly cls: ClsService<AppClsStore>) {}

  get requestId(): string | undefined {
    return this.cls.isActive() ? this.cls.get('requestId') : undefined;
  }
}

import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { HttpRequestError, ResilientHttpClient } from '@app/infrastructure/http-client/resilient-http-client';

export interface CoreProduct {
  id: string;
  title: string;
  description?: string;
  price: number;
  quantity: number;
  category: string;
  shopId: string | null;
  rating?: number;
}

/**
 * The BFF's only way to reach domain logic: HTTP to core (no shared DB
 * access - "no god BFF", 10/04 #4). Keep-alive pooled (undici Agent), every
 * call with its own timeout; the caller's bearer token is forwarded so core
 * still authorizes everything.
 */
@Injectable()
export class CoreClient {
  private readonly http = new ResilientHttpClient('core');
  private readonly base: string;

  constructor(config: ApiConfigService) {
    this.base = (config.get('core_internal_url') || 'http://localhost:8000').replace(/\/$/, '');
  }

  async get<T>(path: string, { auth, timeoutMs = 1_000, signal }: { auth?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const res = await this.http.requestJson<T>(`${this.base}/api${path}`, { headers: auth ? { authorization: auth } : {}, timeoutMs, maxRetries: 0, signal });
    if (res.status === 404) throw new HttpRequestError('not found', 404);
    if (res.status >= 400) throw new HttpRequestError(`core ${path} → ${res.status}`, res.status);
    return res.body;
  }

  product(id: string, auth?: string) {
    return this.get<CoreProduct>(`/products/${id}`, { auth, timeoutMs: 800 });
  }

  products(ids: string[]) {
    return this.get<(CoreProduct | null)[]>(`/batch/products?ids=${ids.join(',')}`, { timeoutMs: 800 });
  }

  shops(ids: string[]) {
    return this.get<({ id: string; name: string; slug: string } | null)[]>(`/batch/shops?ids=${ids.join(',')}`, { timeoutMs: 500 });
  }
}

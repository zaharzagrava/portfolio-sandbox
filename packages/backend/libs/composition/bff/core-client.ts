import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { ResilientHttpClient } from '@app/infrastructure/http-client';

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
  private readonly http = ResilientHttpClient.create({
    name: 'core',
    internal: true,
  });
  private readonly base: string;

  constructor(config: ApiConfigService) {
    this.base = (
      config.get('core_internal_url') || 'http://localhost:8000'
    ).replace(/\/$/, '');
  }

  async get<T>(
    path: string,
    {
      auth,
      timeoutMs = 1_000,
      signal,
    }: { auth?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await this.http.requestJson<T>(`${this.base}/api${path}`, {
      headers: auth ? { authorization: auth } : {},
      timeoutMs,
      maxAttempts: 1,
      signal,
    });
    return res.body;
  }

  product(id: string, auth?: string) {
    return this.get<CoreProduct>(`/products/${id}`, { auth, timeoutMs: 800 });
  }

  products(ids: string[]) {
    return this.get<(CoreProduct | null)[]>(
      `/batch/products?ids=${ids.join(',')}`,
      { timeoutMs: 800 },
    );
  }

  shops(ids: string[]) {
    return this.get<({ id: string; name: string; slug: string } | null)[]>(
      `/batch/shops?ids=${ids.join(',')}`,
      { timeoutMs: 500 },
    );
  }
}

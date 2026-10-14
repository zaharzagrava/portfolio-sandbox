import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import type { Peppers } from '../domain/api-key-format';

/**
 * The key-hash peppers from the validated configuration (S42 G-01). `api_key_pepper` is required (startup fails without
 * it, `developer-platform-config.ts`) and never falls back to the JWT secret; `api_key_pepper_previous` only exists
 * during a rotation.
 */
@Injectable()
export class KeyPeppers {
  constructor(private readonly config: ApiConfigService) {}

  get current(): Peppers {
    const previous = this.config.get('api_key_pepper_previous');
    return {
      current: this.config.get('api_key_pepper'),
      ...(previous ? { previous } : {}),
    };
  }
}

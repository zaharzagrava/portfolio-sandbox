import { HttpStatus } from '@nestjs/common';
import { AppError, ConfiguredErrorParams, ErrorArea } from '@app/common/errors/error.types';

export class Domain_CircuitBreakerOpenError extends AppError {
  constructor(params?: ConfiguredErrorParams) {
    super({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      detail: 'Stripe circuit breaker is open',
      title: 'Payment provider unavailable',
      area: ErrorArea.DOMAIN,
      ...params,
    });
  }
}

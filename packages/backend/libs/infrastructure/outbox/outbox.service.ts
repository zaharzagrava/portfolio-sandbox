import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Transaction } from 'sequelize';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { DbUtilsService } from '@app/infrastructure/database/db-utils/db-utils.service';
import { OutboxDtoService } from './dto/outbox-dto.service';
import { CreateOutboxDto, OutboxWrapperConfig } from './types';
import { AppError, ErrorArea, Fatal_DomainErrorIsThrown, Fatal_InternalServerError, Fatal_RetriesExhaustedError } from '@app/common/errors/error.types';

@Injectable()
export class OutboxService {
  private readonly l = new Logger(OutboxService.name);

  constructor(
    private readonly configService: ApiConfigService,
    private readonly dbUtilsService: DbUtilsService,
    private readonly outboxDtoService: OutboxDtoService,
  ) { }

  async wrapInOutbox<T, P>(
    fun: () => Promise<T>,
    config: OutboxWrapperConfig<P> & { maxRetries?: number },
  ): Promise<T | void> {
    const maxRetries = config.maxRetries ?? 3;
    const maxAttempts = maxRetries + 1; // 1 initial attempt + retries

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fun();
      } catch (_error: any) {
        let error: AppError = (() => {
          // If it's an AppError, return it as is
          if (_error instanceof AppError) {
            // Except if it's a domain error, which should be handled gracefully in the appropriate module
            if (_error.area === ErrorArea.DOMAIN) {
              return new Fatal_DomainErrorIsThrown({ causes: [_error] });
            }
            return _error;
          } else {
            // Native JavaScript deterministic engine bugs
            const isCodeBug =
              _error instanceof TypeError ||
              _error instanceof ReferenceError ||
              _error instanceof SyntaxError ||
              _error instanceof RangeError ||
              _error instanceof URIError;

            return new AppError({
              detail: _error.message || 'Unexpected infrastructure failure',
              status: HttpStatus.INTERNAL_SERVER_ERROR,
              area: isCodeBug ? ErrorArea.FATAL : ErrorArea.TRANSIENT,
              title: isCodeBug ? 'Fatal Code Bug' : 'Unexpected infrastructure failure',
              causes: [_error],
            });
          }
        })();

        if (error.area === ErrorArea.TRANSIENT && attempt < maxAttempts) {
          // Exponential backoff: 1s, 2s, 4s
          const delayMs = Math.pow(2, attempt - 1) * 1000;
          this.l.warn(
            `[Transient Failure] Attempt ${attempt}/${maxAttempts} failed. Retrying in ${delayMs}ms. Reason: ${error.message}`,
          );

          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue; // Loop around for the next attempt
        }

        if (error.area === ErrorArea.TRANSIENT && attempt === maxAttempts) {
          this.l.error(`[Transient Failure] Max retries (${maxRetries}) exhausted. Routing to DLQ.`);
          error = new Fatal_RetriesExhaustedError({
            detail: `Retries Exhausted after ${maxRetries} attempts`,
            title: `Retries Exhausted after ${maxRetries} attempts`,
            causes: [error],
          });
        }

        // 4. DLQ & Observability Logic (Only reached on FATAL or Exhausted)
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
          activeSpan.recordException(error);
          activeSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: `Fatal error routed to DLQ topic [${config.dlqTopic}]: ${error.message}`,
          });
        }

        await this.dbUtilsService.wrapInTransaction(async (tx) => {
          await this.outboxDtoService.create({
            params: {
              topic: config.dlqTopic,
              payload: config.payload,
              error: error.toJSON(true),
            },
            tx,
          });
        });

        this.l.error(
          `[Fatal Event Handled] Written to DLQ topic [${config.dlqTopic}]. ACKing Kafka offset.`,
        );

        return; // Break the loop and successfully ACK the message
      }
    }
  }

  public async notify(
    topic: CreateOutboxDto,
    tx?: Transaction,
  ): Promise<void> {
    await this.dbUtilsService.wrapInTransaction(async (tx) => {
      await this.outboxDtoService.create({
        params: {
          topic: topic.topic,
          extra: topic.extra,
          payload: topic.payload,
          error: topic.error,
          aggregateId: topic.aggregateId,
        },
        tx,
      });
    }, tx);
  }
}

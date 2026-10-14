import {
  Injectable,
  createParamDecorator,
  type ExecutionContext,
  type PipeTransform,
} from '@nestjs/common';
import { readEnvelope } from '../domain/event-schema';
import { validationFailed } from '../domain/experiment-errors';
import { mediaTypeOf, type IngestRequest } from './ingest-body.guard';

/** What the route received: the parsed JSON body, or the bytes of a `text/plain` body read by the guard. */
export interface IngestPayloadValue {
  json?: unknown;
  text?: string;
}

/** The raw payload of the request, for `IngestBodyPipe` (a pipe cannot see the request itself). */
export const IngestPayload = createParamDecorator(
  (_data: unknown, context: ExecutionContext): IngestPayloadValue => {
    const req = context
      .switchToHttp()
      .getRequest<IngestRequest & { body?: unknown }>();
    return mediaTypeOf(req) === 'text/plain'
      ? { text: req.rawBody?.toString('utf8') ?? '' }
      : { json: req.body };
  },
);

/**
 * Turns the payload into the list of events: a `text/plain` body is parsed as the same JSON, and anything that is not
 * `{events: [1..50]}` is `400 validation_failed`. The controller therefore has no `try/catch` (S39 B2).
 */
@Injectable()
export class IngestBodyPipe implements PipeTransform<
  IngestPayloadValue,
  unknown[]
> {
  transform(payload: IngestPayloadValue): unknown[] {
    let body: unknown = payload.json;
    if (payload.text !== undefined) {
      try {
        body = JSON.parse(payload.text);
      } catch {
        throw validationFailed(['body']);
      }
    }
    const events = readEnvelope(body);
    if (!events) throw validationFailed(['events']);
    return events;
  }
}

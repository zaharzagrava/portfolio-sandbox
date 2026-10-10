import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { UserRawDto } from '../users.dto';

/**
 * The authenticated principal (`{id, role, sessionId, amr}`, from verified token claims). The declared type stays
 * `UserRawDto` for the callers that have not moved yet (IX.7 transition); they read `id` and `role` only.
 */
export const User: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request: { user: UserRawDto } = ctx.switchToHttp().getRequest();
    return request.user || null;
  },
);

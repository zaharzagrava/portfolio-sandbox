import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiConfigService } from '@app/common/config';
import { EvalContextService } from '../application/eval-context.service';
import { FlagsClient } from '../application/flags-client.service';
import { factsFromRequest } from './request-context';

const FLAG = 'flags:require';

/**
 * Routes behind a flag look like they do not exist (the same `404`, with the same `Cannot <METHOD> <url>` detail, as an
 * undefined route) until the flag evaluates to `true` for the caller; an unknown, archived, disabled or killed flag gates
 * closed (FR-045). The context is built as for the client endpoint, so the shop is only believed after the membership check.
 *
 * Guards of one handler run bottom decorator first: write `@RequireFlag(key)` ABOVE `@Firewall(...)` so the principal is
 * known when the gate decides (without it the caller is an anonymous visitor).
 */
@Injectable()
export class FlagGuard implements CanActivate {
  constructor(
    private readonly flags: FlagsClient,
    private readonly contexts: EvalContextService,
    private readonly config: ApiConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const key = this.reflector.get<string>(FLAG, ctx.getHandler());
    if (!key) return true;
    const req = ctx.switchToHttp().getRequest();
    const context = await this.contexts.build(
      factsFromRequest(req, this.config.get('flags_edge_secret')),
    );
    if (!this.flags.isEnabled(key, context))
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    return true;
  }
}

export const RequireFlag = (key: string) =>
  applyDecorators(SetMetadata(FLAG, key), UseGuards(FlagGuard));

import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AssignmentsResponse } from '@marketplace-sandbox/contracts';
import { Firewall } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { AssignmentService } from '../application/assignment.service';
import { factsFromRequest } from './request-context';

/**
 * `GET /api/experiments/assignments`: public, one call. The answer depends on the caller (the principal and the anonymous
 * id), so it is never shared-cached. Only the authenticated principal selects the `user` unit; the anonymous id is used
 * only in the allowed shape, else ignored (S39 FR-030).
 */
@ApiTags('experiments')
@Controller()
export class ExperimentAssignmentsController {
  constructor(private readonly assignments: AssignmentService) {}

  @Firewall({ anonymous: true })
  @RateLimit('experiments.assignments')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization, X-Anonymous-Id')
  @Get('experiments/assignments')
  forCaller(
    @Req() req: Parameters<typeof factsFromRequest>[0],
  ): Promise<AssignmentsResponse> {
    const facts = factsFromRequest(req, undefined);
    return this.assignments.assignments({
      userId: facts.userId,
      anonymousId: facts.anonymousId,
    });
  }
}

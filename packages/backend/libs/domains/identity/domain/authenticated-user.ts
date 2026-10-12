import type { Role } from './role';

/** The principal of a request, built from verified token claims only (no per-request user lookup). */
export interface AuthenticatedUser {
  id: string;
  role: Role;
  sessionId: string;
  amr: string[];
}

/** A service caller (S01 US8): the `act` claim of an exchanged token names the user it acts for. */
export interface ServicePrincipal {
  kind: 'service';
  caller: string;
  onBehalfOf?: { userId: string; sessionId: string };
}

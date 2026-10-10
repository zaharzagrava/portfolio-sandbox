import type { Request } from 'express';
import type { AuthenticatedUser } from '../domain/authenticated-user';

/** An Express request after the identity guards have attached the authenticated principal (claims only). */
export interface RequestWithUser extends Request {
  user: AuthenticatedUser;
}

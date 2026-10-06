import type { Request } from 'express';
import { UserRawDto } from './users.dto';

/** An Express request after the identity guards have attached the authenticated user. */
export interface RequestWithUser extends Request {
  user: UserRawDto;
}

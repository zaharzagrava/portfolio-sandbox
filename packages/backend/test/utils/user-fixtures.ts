import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import { Role, UserModel } from '@app/domains/identity';

/**
 * Seeds a passwordless user row for specs of other capabilities. Test code may touch every table (IX.6); keeping the
 * `UserModel` here means a capability's own testing kit never injects another domain's model (S28 D-7).
 */
export async function createUser(
  app: INestApplication,
  options: { email: string; role?: Role },
): Promise<{ id: string; email: string; role: Role }> {
  const users = app.get<typeof UserModel>(getModelToken(UserModel));
  const user = await users.create({
    email: options.email,
    passwordHash: null,
    role: options.role ?? Role.USER,
  });
  return { id: user.id, email: user.email!, role: user.role };
}

/** A user whose identity record has no e-mail address (a federated account that never shared one). */
export async function createUserWithoutEmail(
  app: INestApplication,
  options: { role?: Role } = {},
): Promise<{ id: string; role: Role }> {
  const users = app.get<typeof UserModel>(getModelToken(UserModel));
  const user = await users.create({
    email: null,
    passwordHash: null,
    role: options.role ?? Role.USER,
  });
  return { id: user.id, role: user.role };
}

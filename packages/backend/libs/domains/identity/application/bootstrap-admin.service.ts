import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import {
  PASSWORD_HASHER,
  USER_REPOSITORY,
  type PasswordHasherPort,
  type UserRepository,
} from '../domain/ports';
import { normalizeEmail } from '../domain/password-policy';
import { Role } from '../domain/role';

/**
 * Local profile only (J02 G-02): provisions one platform `ADMIN` from `BOOTSTRAP_ADMIN_EMAIL` and
 * `BOOTSTRAP_ADMIN_PASSWORD`, so a fresh stack has an operator without a seed script. Idempotent (an existing account with
 * that address is left alone), and the configuration rules refuse both settings when `NODE_ENV=production`, so the app
 * does not boot there. Registration still rejects `ADMIN` (S01.R-03): this is the only way in.
 */
@Injectable()
export class BootstrapAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapAdminService.name);

  constructor(
    private readonly config: ApiConfigService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.provision();
  }

  /** Returns whether an account was created (false: not configured, or it already exists). */
  async provision(): Promise<boolean> {
    const rawEmail = this.config.get('bootstrap_admin_email');
    const password = this.config.get('bootstrap_admin_password');
    if (!rawEmail || !password) return false;
    const email = normalizeEmail(rawEmail);
    if (await this.users.findByEmail(email)) return false;
    const { created } = await this.users.insertIfAbsent({
      email,
      passwordHash: await this.hasher.hash(password),
      role: Role.ADMIN,
    });
    if (created)
      this.logger.log(`bootstrap administrator provisioned (${email})`);
    return created;
  }
}

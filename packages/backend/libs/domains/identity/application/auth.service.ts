import {
  ConflictException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { KeyStore } from '../infra/keys/key-store.service';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import User, { Role } from '../infra/models/user.model';
import { InjectModel } from '@nestjs/sequelize';
import { UniqueConstraintError } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import * as path from 'path';
import {
  AuthResponseDto,
  JwtPayloadDto,
  PasswordLoginDto,
  RegisterDto,
} from '../api/auth.dto';

const BCRYPT_ROUNDS = 10;
const DEFAULT_ACCESS_TOKEN_TTL = '1h';

/**
 * Access tokens are RS256 so the Cloudflare edge worker can verify them with
 * only the public key (packages/edge-be, env.JWT_PUBLIC_KEY) - the private
 * key never leaves this service. `jwt_secret` (HS256) is reserved for the
 * short-lived chat WS tickets shared with the Rust gateway.
 */
@Injectable()
export class AuthService {
  private privateKey: string | null = null;
  private publicKey: string | null = null;

  /**
   * Compared against when the email is unknown so "no such user" and "wrong
   * password" take the same time - otherwise response latency leaks which
   * emails are registered.
   */
  private readonly dummyHash = bcrypt.hashSync(
    'timing-equalizer',
    BCRYPT_ROUNDS,
  );

  constructor(
    @InjectModel(User) private userModel: typeof User,
    private configService: ApiConfigService,
    @Optional() private readonly keyStore?: KeyStore,
    @Optional() private readonly cache?: CacheService,
  ) {}

  public async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    try {
      const user = await this.userModel.create({
        email: dto.email,
        passwordHash,
        role: dto.role ?? Role.USER,
      });

      return this.issueTokens(user);
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new ConflictException('Email is already registered');
      }
      throw error;
    }
  }

  public async login(dto: PasswordLoginDto): Promise<AuthResponseDto> {
    const user = await this.userModel.findOne({
      where: { email: dto.email },
      raw: true,
    });

    const isValid = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? this.dummyHash,
    );

    if (!user || !user.passwordHash || !isValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.issueTokens(user);
  }

  /**
   * Verifies an access token and resolves the user.
   *  - Tokens with a `kid` (SD-39): key from the rotating KeyStore, algorithm
   *    pinned to that key's alg, issuer checked.
   *  - Tokens without `kid`: legacy RS256 key (creds/), so existing clients and
   *    the edge worker keep working during the migration.
   * The user row is cached (L1/L2, 60 s) - verifying a token must not cost a
   * Postgres query on every request at 100k RPS.
   */
  public async userAuthentication(
    userAuthToken?: string,
  ): Promise<User & { sessionId?: string }> {
    if (!userAuthToken) {
      throw new UnauthorizedException('No auth token provided');
    }

    let payload: JwtPayloadDto & { sid?: string; purpose?: string };
    try {
      const header = jwt.decode(userAuthToken, { complete: true })?.header;
      if (header?.kid) {
        const resolved = await this.keyStore?.verificationKey(header.kid);
        if (!resolved) throw new Error('unknown kid');
        payload = jwt.verify(userAuthToken, resolved.key, {
          algorithms: [resolved.alg],
          issuer: 'marketplace',
        }) as typeof payload;
      } else {
        payload = jwt.verify(userAuthToken, this.getPublicKey(), {
          algorithms: ['RS256'],
        }) as typeof payload;
      }
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    // Purpose-scoped tokens (MFA challenge, WS tickets) can't be used as access tokens.
    if (!payload?.sub || typeof payload.sub !== 'string' || payload.purpose) {
      throw new UnauthorizedException('Invalid token format');
    }

    const load = () =>
      this.userModel.findOne({
        where: { id: payload.sub },
        attributes: {
          exclude: ['passwordHash', 'mfaSecretEnc', 'mfaRecoveryCodes'],
        },
        raw: true,
      });
    const user = this.cache
      ? await this.cache.getOrLoad(`auth:user:v1:${payload.sub}`, load, {
          ttlMs: 60_000,
          negativeTtlMs: 5_000,
        })
      : await load();

    if (!user) {
      throw new UnauthorizedException('Invalid token');
    }

    return { ...user, sessionId: payload.sid } as User & { sessionId?: string };
  }

  /** Public for internal callers that already authenticated the user another way (SSO callback, e2e specs). */
  public issueTokensFor(
    user: Pick<User, 'id' | 'email' | 'role'>,
  ): AuthResponseDto {
    return this.issueTokens(user);
  }

  private issueTokens(
    user: Pick<User, 'id' | 'email' | 'role'>,
  ): AuthResponseDto {
    const expiresIn =
      this.configService.get('jwt_expires_in') || DEFAULT_ACCESS_TOKEN_TTL;
    const payload: JwtPayloadDto = { sub: user.id, role: user.role };

    const token = jwt.sign(payload, this.getPrivateKey(), {
      algorithm: 'RS256',
      expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
    });

    return {
      accessToken: { token, expiresIn },
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  private getPrivateKey(): string {
    if (!this.privateKey) {
      this.privateKey =
        this.configService.get('jwt_private_key') ||
        this.readKeyFile('creds/jwtRS256.key');
    }
    return this.privateKey;
  }

  private getPublicKey(): string {
    if (!this.publicKey) {
      this.publicKey =
        this.configService.get('jwt_public_key') ||
        this.readKeyFile('creds/jwtRS256.key.pub');
    }
    return this.publicKey;
  }

  private readKeyFile(relativePath: string): string {
    const absolutePath = path.resolve(process.cwd(), relativePath);
    try {
      return fs.readFileSync(absolutePath, 'utf8');
    } catch {
      throw new Error(
        `JWT key not found at ${absolutePath}. Set JWT_PRIVATE_KEY/JWT_PUBLIC_KEY or run scripts/auth/generate-keys.js`,
      );
    }
  }
}

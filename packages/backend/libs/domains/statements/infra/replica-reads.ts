import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { ApiConfigModule } from '@app/common/config';
import {
  READ_REPLICA_CONNECTION,
  readReplicaProvider,
} from '@app/infrastructure/database/read-replica.provider';
import { replicaFallbackCounter } from '../domain/metrics';

const CONNECTION_ERRORS = new Set([
  'SequelizeConnectionError',
  'SequelizeConnectionRefusedError',
  'SequelizeHostNotFoundError',
  'SequelizeHostNotReachableError',
  'SequelizeInvalidConnectionError',
  'SequelizeConnectionTimedOutError',
  'SequelizeConnectionAcquireTimeoutError',
]);
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
]);

export function isConnectionFailure(error: unknown): boolean {
  const e = error as {
    name?: string;
    parent?: { code?: string };
    code?: string;
  };
  return (
    CONNECTION_ERRORS.has(e?.name ?? '') ||
    NETWORK_CODES.has(e?.parent?.code ?? '') ||
    NETWORK_CODES.has(e?.code ?? '')
  );
}

/**
 * Runs a read on the reporting replica (S16 FR-053; platform handle `READ_REPLICA_CONNECTION`) and, when the replica
 * cannot be reached, once on the primary with a metric. Only for reads outside a transaction: the replica is another
 * connection, so it never sees the caller's uncommitted work.
 */
@Injectable()
export class ReplicaReads {
  private readonly logger = new Logger(ReplicaReads.name);

  constructor(
    @InjectConnection() private readonly primary: Sequelize,
    @Optional()
    @Inject(READ_REPLICA_CONNECTION)
    private readonly replica?: Sequelize,
  ) {}

  /** `primary: true` for a read that must see this process's own writes (inside a transaction, or just after one). */
  async run<T>(
    read: (db: Sequelize) => Promise<T>,
    options: { primary?: boolean } = {},
  ): Promise<T> {
    if (!this.replica || options.primary) return read(this.primary);
    try {
      return await read(this.replica);
    } catch (error) {
      if (!isConnectionFailure(error)) throw error;
      replicaFallbackCounter.add();
      this.logger.warn(
        'reporting replica unreachable: reading from the primary once',
      );
      return read(this.primary);
    }
  }

  get replicaHandle(): Sequelize | undefined {
    return this.replica;
  }
}

/** The replica handle for processes that do not already hold one (a lazy pool: no connection until the first read). */
@Module({
  imports: [ApiConfigModule],
  providers: [readReplicaProvider],
  exports: [READ_REPLICA_CONNECTION],
})
export class StatementsReplicaModule implements OnApplicationShutdown {
  constructor(
    @Inject(READ_REPLICA_CONNECTION) private readonly replica: Sequelize,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.replica.close().catch(() => undefined);
  }
}

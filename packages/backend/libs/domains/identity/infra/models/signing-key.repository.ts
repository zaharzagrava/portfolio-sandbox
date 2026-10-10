import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { UniqueConstraintError } from 'sequelize';
import type { SigningKeyRepository, SigningKeyRow } from '../../domain/ports';
import SigningKey from './signing-key.model';

/** Postgres adapter of the `SIGNING_KEY_REPOSITORY` port. */
@Injectable()
export class SequelizeSigningKeyRepository implements SigningKeyRepository {
  constructor(
    @InjectModel(SigningKey) private readonly keys: typeof SigningKey,
  ) {}

  async list(): Promise<SigningKeyRow[]> {
    const rows = await this.keys.findAll({ raw: true });
    return rows.map((row) => ({
      kid: row.kid,
      status: row.status,
      publicJwk: row.publicJwk,
      privateKeySealed: row.privateKeyEnc,
      activatedAt: row.activatedAt,
      retiredAt: row.retiredAt,
      createdAt: row.createdAt,
    }));
  }

  async insert(row: Omit<SigningKeyRow, 'retiredAt'>): Promise<boolean> {
    try {
      await this.keys.create({
        kid: row.kid,
        alg: 'ES256',
        publicJwk: row.publicJwk,
        privateKeyEnc: row.privateKeySealed,
        status: row.status,
        activatedAt: row.activatedAt,
        createdAt: row.createdAt,
      });
      return true;
    } catch (error) {
      // Only the unique indexes (one ACTIVE, one NEXT) mean "another instance got there first".
      if (error instanceof UniqueConstraintError) return false;
      throw error;
    }
  }
}

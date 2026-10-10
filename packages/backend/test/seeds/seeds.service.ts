import { QueryTypes } from 'sequelize';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import {
  CreateTreelikeClass,
  CreateTreelikeOptions,
  DBRelation,
  RelationData,
  Schema,
  SqlModel,
  SqlModelClass,
  TableData,
  TableName,
} from './types';
import * as _ from 'lodash';

import { UserModel as User } from '@app/domains/identity';
import Migration from '@app/infrastructure/database/migration.model';
import { BisOrderModel as BisOrder } from '@app/domains/orders';
import Outbox from '@app/infrastructure/outbox/outbox.model';
import { ProductModel as Product } from '@app/domains/catalog';
import { TestCleanupRegistry } from '../utils/test-cleanup.registry';
import { ApiConfigService } from '@app/common/config';
import { TsNodeUtilsService } from '@app/common/scripts/ts-node-utils.service';
import { v4 as uuidv4 } from 'uuid';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class SeedsService {
  private readonly l = new Logger(SeedsService.name);
  private schema: Schema;

  constructor(
    private readonly configService: ApiConfigService,
    private readonly tsNodeUtilsService: TsNodeUtilsService,
    @InjectModel(BisOrder) private bisOrderModel: typeof BisOrder,
    @InjectModel(User) private userModel: typeof User,
    @InjectModel(Migration)
    private migrationModel: typeof Migration,
    @InjectModel(Outbox) private outboxModel: typeof Outbox,
    @InjectModel(Product) private productModel: typeof Product,
    @Optional() private readonly testCleanupRegistry?: TestCleanupRegistry,
  ) {
    /**
     * @description
     *    - convention: in tests the current period is 202201 by default, seeds service sets
     *      startPeriod of UserKpiAssignment to 2021, as well as for KpiValue, so you should
     *      stick to 202201 as current period for consistency unless needed otherwise
     */
    this.schema = {
      User: {
        sqlModel: this.userModel,
        defaults: {},
        relations: {},
      },
      BisOrder: {
        sqlModel: this.bisOrderModel,
        defaults: {},
        relations: {
          user: {
            model: User,
            foreignKey: 'userId',
            relationType: DBRelation.belongsTo,
          },
        },
      },
      Outbox: {
        sqlModel: this.outboxModel,
        defaults: {},
        relations: {},
      },
      Product: {
        sqlModel: this.productModel,
        defaults: {
          title: () => `Product ${uuidv4().slice(0, 8)}`,
          description: 'Seeded product',
          brand: 'Acme',
          category: 'electronics',
          price: 100_00,
          quantity: 10,
        },
        relations: {},
      },
    };
  }

  /**
   * Empties every table except migration-managed reference data (plans, prices, commission rates).
   * One TRUNCATE … CASCADE instead of per-model deletes: new tables with FKs to User/Shop/Product
   * can't break the cleanup order, and it's faster than DELETE.
   */
  public async clean() {
    this.l.log(`--- Clearing the database ---`);
    const sequelize = this.productModel.sequelize!;
    const tables = await sequelize.query<{ name: string }>(
      `SELECT table_name::text AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT IN (:keep)`,
      {
        type: QueryTypes.SELECT,
        replacements: { keep: SeedsService.KEEP_TABLES },
      },
    );
    if (tables.length) {
      // The app's own background pollers (outbox, jobs) may hold row locks: retry a deadlock a few times.
      for (let attempt = 1; ; attempt++) {
        try {
          await sequelize.query(
            `TRUNCATE ${tables.map((t) => `"${t.name}"`).join(', ')} RESTART IDENTITY CASCADE`,
          );
          break;
        } catch (error) {
          const pg = (error as { parent?: { message?: string; code?: string } })
            .parent;
          if (pg?.code === '40P01' && attempt < 5) {
            await new Promise((r) => setTimeout(r, 100 * attempt));
            continue;
          }
          throw new Error(
            `seeds.clean TRUNCATE failed: ${pg?.message ?? (error as Error).message}`,
          );
        }
      }
    }

    // Non-Postgres stores registered by feature modules (Redis, Scylla, Dynamo, SQS, ...)
    await this.testCleanupRegistry?.runAll();
  }

  private static readonly KEEP_TABLES = [
    'SequelizeMeta',
    'spatial_ref_sys',
    'Plan',
    'Price',
    'CommissionRate',
    // S32: the synonym set is seeded by its migration (version 1)
    'SearchSynonymSet',
    'SearchSynonymVersion',
  ];

  public getModel(modelType: BisOrder | User | Migration | Outbox) {
    if (modelType instanceof BisOrder) {
      return this.bisOrderModel;
    } else if (modelType instanceof User) {
      return this.userModel;
    } else if (modelType instanceof Migration) {
      return this.migrationModel;
    } else if (modelType instanceof Outbox) {
      return this.outboxModel;
    }
  }

  public async createTreelike(
    argEntities: CreateTreelikeClass[],
    { argDepth, reparse }: CreateTreelikeOptions = {},
  ): Promise<Array<any>> {
    const depth = argDepth || 0;

    let entities = argEntities;
    if (depth === 0) {
      entities = _.cloneDeep(entities);
    }

    const createdInstances: any[] = [];

    for (const entity of entities) {
      // Get the DB sequelize model of this entity
      const modelInfo: TableData = this.schema[
        entity.__type__ as TableName
      ] as unknown as any;
      const relationsModelInfo: TableData<SqlModel, SqlModelClass> = this
        .schema[entity.__type__ as TableName].relations as unknown as any;

      // Create the entity
      let createdInstance: any;
      try {
        createdInstance = await modelInfo.sqlModel.create<SqlModelClass>({
          ...this.resolveDefaults(modelInfo.defaults),
          ...entity,
        });
      } catch (error) {
        console.log('--- Entity creation error ---');
        console.log(error);
        console.log(JSON.stringify(error, null, 2));
      }

      // Loop over related models of current model
      for (const relModelKey of Object.keys(relationsModelInfo)) {
        const relatedModelName: string = Object.keys(entity).find(
          (key) => key === relModelKey,
        ) as any;

        // If relModelKey is not found on this entity, try another
        if (!relatedModelName) continue;

        // eslint-disable-next-line
        // @ts-ignore
        const relationData: RelationData = relationsModelInfo[
          relatedModelName
        ] as any as RelationData;
        const relatedEntities: CreateTreelikeClass[] = entity[
          relatedModelName as keyof CreateTreelikeClass
        ] as any;

        const createdRelatedInstances: any[] = [];
        // Loop over related entities that we need to create
        for (const relatedEntity of relatedEntities) {
          // Parse special instructions
          if (
            relatedEntity[
              relationData.foreignKey as keyof CreateTreelikeClass
            ] === 'GET_FROM_PARENT'
          ) {
            relatedEntity[
              relationData.foreignKey as keyof CreateTreelikeClass
            ] = createdInstance.id;
          }

          // Recursively call create for related entity
          const createdRelatedInstance = (
            await this.createTreelike([relatedEntity], { argDepth: depth + 1 })
          )[0];

          // Execute attachment functionality
          if (relationData.relationType === DBRelation.belongsTo) {
            createdInstance = await createdInstance.update(
              {
                [relationData.foreignKey]: createdRelatedInstance.id,
              },
              { returning: true },
            );

            createdRelatedInstances.push(createdRelatedInstance);
          } else if (relationData.relationType === DBRelation.hasMany) {
            createdRelatedInstances.push(
              await createdRelatedInstance.update(
                {
                  [relationData.foreignKey]: createdInstance.id,
                },
                { returning: true },
              ),
            );
          } else if (relationData.relationType === DBRelation.belongsToMany) {
            const createdInstanceForeignKey = this.schema[
              relationData.foreignKey as keyof Schema
            ] as any;
            const createdRelatedInstanceForeignKey = this.schema[
              relationData.foreignKey as keyof Schema
            ] as any;

            // Create or update junction entity
            // eslint-disable-next-line
            // @ts-ignore
            await relationData.through.bulkCreate<SqlModelClass>(
              [
                {
                  [createdInstanceForeignKey]: createdInstance.id,
                  [createdRelatedInstanceForeignKey]: createdRelatedInstance.id,
                  ...(relatedEntity[
                    '__junctionEntity__' as keyof CreateTreelikeClass
                  ] as any),
                },
              ],
              {
                ignoreDuplicates: true,
              },
            );
          } else {
            throw new Error('This relation type is not supported');
          }
        }

        createdInstance.setDataValue(relatedModelName, createdRelatedInstances);
      }

      createdInstances.push(createdInstance);
    }

    if (depth === 0 && reparse)
      return this.tsNodeUtilsService.reparse(createdInstances);

    return createdInstances;
  }

  private resolveDefaults(defaults: Record<string, any | (() => any)>) {
    const resolvedDefaults = {};
    for (const defaultKey of Object.keys(defaults)) {
      // eslint-disable-next-line
      // @ts-ignore
      resolvedDefaults[defaultKey] =
        typeof defaults[defaultKey] === 'function'
          ? defaults[defaultKey]()
          : defaults[defaultKey];
    }

    return resolvedDefaults;
  }

  async seedLocalTest() {
    let user = await this.userModel.findOne({});

    if (!user) {
      user = await this.userModel.create({});
    }

    let bisOrder = await this.bisOrderModel.findOne({
      where: {
        userId: user.id,
      },
    });

    if (!bisOrder) {
      bisOrder = await this.bisOrderModel.create({
        userId: user.id,
      });
    }

    console.log('Created user and bis order', user.id, bisOrder.id);

    return { user, bisOrder };
  }

  /* Utility methods */
  public async seedLoadTest() {
    this.l.log(`--- Clearing the database ---`);

    await this.clean();

    const USER_COUNT = 1_000;

    const allData: {
      userId: string;
      bisOrderId: string;
      jwtToken: string;
      amount: number;
      paymentMethodId: string;
    }[] = [];

    for (let i = 0; i < USER_COUNT; i++) {
      const user = await this.userModel.create();
      const jwtToken = this.generateJwtToken(user.id);

      const bisOrder = await this.bisOrderModel.create({
        userId: user.id,
      });

      allData.push({
        userId: user.id,
        bisOrderId: bisOrder.id,
        jwtToken,
        amount: this.randomInt(1, 1000),
        paymentMethodId: this.randomPaymentMethodId(),
      });

      if ((i + 1) % 1000 === 0 || i === USER_COUNT - 1) {
        this.l.log(`Created ${i + 1}/${USER_COUNT} users and bis orders...`);
      }
    }

    // For demo, log a sample and count:
    this.l.log(`Generated sample data. First record:`, allData[0]);
    this.l.log(`Total user-bisOrder pairs created: ${allData.length}`);

    // Ensure directory exists before writing the file
    const dataDir = path.resolve('scripts/load-tests/data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(
      'scripts/load-tests/data/default.json',
      JSON.stringify(allData, null, 2),
    );
  }

  // Read private key only once
  private PRIVATE_KEY: string | null = null;
  private getPrivateKey(): string {
    if (!this.PRIVATE_KEY) {
      try {
        this.PRIVATE_KEY = fs.readFileSync('creds/jwtRS256.key', 'utf8');
      } catch (err) {
        throw new Error(
          'Private key not found. Please place "creds/jwtRS256.key" in the correct directory.',
        );
      }
    }
    return this.PRIVATE_KEY;
  }

  // Generate JWT token (sync for simplicity)
  private generateJwtToken(userId: string): string {
    const privateKey = this.getPrivateKey();
    const payload = { sub: userId };
    // Sign with RS256 and 7d expiry, just like in the script
    return jwt.sign(payload, privateKey, {
      algorithm: 'RS256',
      expiresIn: '7d',
    });
  }
  // Generates a mock v5 UUID using random + salt (for demonstration only)
  private randomV5(): string {
    return uuidv4(); // Replace with real v5 UUID for production scenario
  }

  // Random integer between min and max inclusive
  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // Generate random payment method id (simulate Stripe style)
  private randomPaymentMethodId(): string {
    // Stripe test payment methods look like "pm_xxxxxxxxxxxxxxxxxxxx"
    return `pm_${Math.random().toString(36).slice(2, 18)}`;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { DbCredsDto } from '../api/admin.dto';
import User from '../infra/models/user.model';

@Injectable()
export class AdminService {
  private readonly l = new Logger(AdminService.name);

  constructor(
    @InjectConnection() private readonly sequelizeInstance: Sequelize,
  ) { }

  private getDbConnection(body: DbCredsDto): Sequelize {
    if (body.isSsh) {
      return new Sequelize({
        dialect: 'postgres',
        port: 5032,
        password: body.password,
        database: body.database,
        username: body.username,
        host: 'localhost',
      });
    }

    return new Sequelize({
      dialect: 'postgres',
      port: body.port,
      password: body.password,
      database: body.database,
      username: body.username,
      host: body.host,
    });
  }

  public async externalDbSync(body: DbCredsDto) {
    const sequelizeConnection = this.getDbConnection(body);

    const models = [
      {
        model: User,
        name: 'User',
      },
    ];

    for (const model of models) {
      await (model.model as any).destroy({
        where: {},
        force: true,
      });
    }

    for (const model of models) {
      this.l.log(`Syncing ${model.name}`);

      const modelData: any[] = (
        await sequelizeConnection.query(`select * from "${model.name}";`)
      )[0];

      await (model.model as any).bulkCreate(
        modelData.map((x) => ({
          ...x,
        })),
      );
    }
  }
}

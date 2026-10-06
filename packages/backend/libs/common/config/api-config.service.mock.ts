import * as _ from 'lodash';
import { Config } from './types';
import { ApiConfigService } from './api-config.service';
import { ConfigUtilsService } from './config-utils/config-utils.service';
import { Environment } from '@app/common/types';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({
  /**
   * This path is relative to /backend/src/config/config.ts file
   *    - in test / local we get .env from backend folder
   *    - in other environments we dont use .env file, instead we use env variables
   *      provided by Elastic Beanstalk + we combine them with secrets provided
   *      from AWS Secrets Manager. Our gitlab deployment machine has a role that
   *      allows it to read from AWS Secrets Manager, so no aws api keys should
   *      be provided for it
   */
  path: path.resolve(
    __dirname,
    (() => {
      switch (process.env.NODE_ENV) {
        case Environment.test:
          return '../../../.env.test';
        case Environment.local:
          return '../../../.env';
        default:
          return '../.env';
      }
    })(),
  ),
});

export class MockApiConfigService extends ApiConfigService {
  public initialConfig: Config;

  reset() {
    this.config = _.cloneDeep(this.initialConfig);
  }

  public async init(): Promise<void> {
    await super.init();

    this.initialConfig = this.config;
  }

  set<K extends keyof Config>(key: K, value: any) {
    this.config[key] = value;
  }

  get<K extends keyof Config>(key: K): Config[K] {
    return this.config[key];
  }
}

export const MockApiConfigServiceFactory = async (
  configUtilsService: ConfigUtilsService,
) => {
  const mockApiConfigService = new MockApiConfigService(configUtilsService);
  await mockApiConfigService.init();
  return mockApiConfigService;
};

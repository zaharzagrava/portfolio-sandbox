import { Injectable } from '@nestjs/common';
import * as joi from 'joi';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { EnvConfig, SecretsManagerConfig } from '../types';

@Injectable()
export class ConfigUtilsService {
  /**
   * In test environments aws_region and aws_secret_id are not defined and so these vars are not fetched
   * In stage / prod environments no keys are needed because our envrionment is configured to have access to the secrets manager
   *
   * @param localConfig
   * @returns
   */
  public async initSecretsManager(
    localConfig: EnvConfig,
  ): Promise<SecretsManagerConfig | undefined> {
    if (!localConfig.aws_region || !localConfig.aws_secret_id) return;

    // Get secrets manager env vars
    const client = new SecretsManagerClient({ region: localConfig.aws_region });

    const input = { SecretId: localConfig.aws_secret_id };
    const command = new GetSecretValueCommand(input);
    const { SecretString } = await client.send(command);

    if (SecretString === undefined)
      throw new Error('AWS Secrets Manager has returned undefined result');
    const secretsManagerEnvVars = JSON.parse(
      SecretString,
    ) as SecretsManagerConfig;

    return secretsManagerEnvVars;
  }

  public parseSrc<T>(
    config: Record<
      string,
      {
        name: string;
        postProcess?: (...args: unknown[]) => T[keyof T];
        verify: joi.AnySchema;
      }
    >,
    srcs: Record<string, T[keyof T]>[],
  ): T {
    // Get
    const configValues: Partial<T> = {};
    for (const [key, configMeta] of Object.entries(config)) {
      configValues[key as keyof T] = this.getConfigVariable(
        configMeta.name,
        srcs,
      );
    }

    // Post-process
    for (const [key, configMeta] of Object.entries(config)) {
      if (configMeta.postProcess === undefined) continue;

      configValues[key as keyof T] = configMeta.postProcess(
        configValues[key as keyof T],
      );
    }

    // Validate
    const configValidationSchemaObj: Record<string, joi.AnySchema> = {};
    for (const [key, configMeta] of Object.entries(config)) {
      configValidationSchemaObj[key] = configMeta.verify;
    }

    const configValidationSchema: joi.ObjectSchema = joi.object(
      configValidationSchemaObj,
    );

    const { error } = configValidationSchema.validate(configValues, {
      allowUnknown: true,
      abortEarly: false,
    });

    if (error) {
      // Keys and the rule that failed, never values: joi messages can quote the offending value (a secret).
      throw new Error(
        `Config validation error: ${error.details.map((d) => `${d.path.join('.')} (${d.type})`).join('; ')}`,
      );
    }

    return configValues as T;
  }

  private getConfigVariable<T>(
    name: string,
    srcs: Record<string, unknown>[],
  ): T[keyof T] | undefined {
    for (const src of srcs) {
      if (src[name] !== undefined) return src[name] as T[keyof T];
    }
  }
}

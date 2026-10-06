import { Injectable, Logger } from '@nestjs/common';
import { CronJob } from 'cron';
import { Environment } from '@app/common/types';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ApiConfigService } from '@app/common/config/api-config.service';

@Injectable()
export class CronService {
  private readonly l = new Logger(CronService.name);

  constructor(
    private apiConfigService: ApiConfigService,
    private schedulerRegistry: SchedulerRegistry,
  ) {}

  add(
    time: {
      cronTime: string;
      spreadByEnvrionment?: number;
    },
    fun: (...args: any[]) => any,
    key: string,
  ) {
    let cronTime: string = time.cronTime;
    if (time.spreadByEnvrionment) {
      let minutes: number | null = null;
      switch (this.apiConfigService.get('node_env')) {
        case Environment.local:
        case Environment.development:
        case Environment.test:
          minutes = 0;
          break;
        case Environment.staging:
          minutes = time.spreadByEnvrionment * 1;
          break;
        case Environment.preprod:
          minutes = time.spreadByEnvrionment * 2;
          break;
        case Environment.production:
          minutes = time.spreadByEnvrionment * 3;
          break;
        default:
          minutes = 0;
          break;
      }

      cronTime = `${minutes} ${time.cronTime.substring(
        time.cronTime.indexOf(' ') + 1,
      )}`;
    }

    const job = new CronJob(cronTime, fun);
    this.schedulerRegistry.addCronJob(key, job);
    job.start();

    this.l.log(`Cron job ${key} at ${cronTime} has been setup`);

    return job;
  }

  delete(key: string) {
    this.schedulerRegistry.deleteCronJob(key);
  }
}

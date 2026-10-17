import { Injectable, Logger } from '@nestjs/common';
import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  type LifecycleRule,
} from '@aws-sdk/client-s3';
import { ApiConfigService } from '@app/common/config';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import type { PageArchive } from '../domain/crawler-ports';

export const ARCHIVE_PREFIX = 'crawl/';
export const ARCHIVE_RETENTION_DAYS = 7;
export const ARCHIVE_RULE_ID = 's41-crawl-archive-7d';
const PUT_TIMEOUT_MS = 5_000;

/**
 * Raw pages of changed targets (S41 FR-024): `crawl/<yyyy-mm-dd>/<host>/<targetId>-<epochMs>.html` in the shared
 * bucket, expiring after 7 days by a lifecycle rule on the prefix that this adapter keeps in place at start.
 */
@Injectable()
export class S3PageArchive implements PageArchive {
  private readonly logger = new Logger(S3PageArchive.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly storage: ObjectStorage,
    config: ApiConfigService,
  ) {
    const endpoint = config.get('s3_endpoint');
    const accessKeyId =
      config.get('s3_access_key_id') ?? config.get('aws_access_key_id');
    const secretAccessKey =
      config.get('s3_secret_access_key') ?? config.get('aws_secret_access_key');
    this.bucket = config.get('media_bucket') ?? 'marketplace-media';
    this.s3 = new S3Client({
      region: config.get('aws_region') || 'eu-central-1',
      ...(endpoint && { endpoint, forcePathStyle: true }),
      ...(accessKeyId && { credentials: { accessKeyId, secretAccessKey } }),
    });
  }

  put(key: string, html: string) {
    return this.storage.put(key, Buffer.from(html), 'text/html', {
      timeoutMs: PUT_TIMEOUT_MS,
    });
  }

  /**
   * Adds the 7-day expiry of the archive prefix to the bucket's lifecycle configuration, keeping every other rule.
   * Idempotent; a failure is logged and retried at the next start (the archive still works without the rule).
   */
  async ensureLifecycle(): Promise<void> {
    try {
      let rules: LifecycleRule[] = [];
      try {
        rules =
          (
            await this.s3.send(
              new GetBucketLifecycleConfigurationCommand({
                Bucket: this.bucket,
              }),
            )
          ).Rules ?? [];
      } catch (error) {
        if (
          (error as { name?: string }).name !== 'NoSuchLifecycleConfiguration'
        )
          throw error;
      }
      const current = rules.find((r) => r.ID === ARCHIVE_RULE_ID);
      if (current?.Expiration?.Days === ARCHIVE_RETENTION_DAYS) return;
      await this.s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.bucket,
          LifecycleConfiguration: {
            Rules: [
              ...rules.filter((r) => r.ID !== ARCHIVE_RULE_ID),
              {
                ID: ARCHIVE_RULE_ID,
                Status: 'Enabled',
                Filter: { Prefix: ARCHIVE_PREFIX },
                Expiration: { Days: ARCHIVE_RETENTION_DAYS },
              },
            ],
          },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `archive lifecycle rule not applied: ${(error as Error).message}`,
      );
    }
  }
}

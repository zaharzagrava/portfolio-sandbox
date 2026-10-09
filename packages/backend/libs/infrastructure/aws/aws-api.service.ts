import { Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { InternalServerError } from '@app/common/errors';
import { gunzip, gzip } from 'zlib';
import { promisify } from 'util';
import { S3ObjectTags } from './types';
import { DbUtilsService } from '@app/infrastructure/database/db-utils/db-utils.service';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

@Injectable()
export class AWSApiService {
  private readonly l = new Logger(AWSApiService.name);
  private readonly s3Client: S3Client;
  private readonly gunzipPr = promisify(gunzip);
  private readonly zipPr = promisify(gzip);

  constructor(
    private configService: ApiConfigService,
    private dbUtilsService: DbUtilsService,
  ) {
    const creds =
      configService.get('aws_access_key_id') &&
      configService.get('aws_secret_access_key')
        ? {
            accessKeyId: configService.get('aws_access_key_id'),
            secretAccessKey: configService.get('aws_secret_access_key'),
          }
        : undefined;

    this.s3Client = new S3Client({
      region: configService.get('aws_region'),
      credentials: creds,
    });
  }

  getCloudfrontUrl(filePath: string) {
    return `https://d2jn8gaxpte8na.cloudfront.net/${filePath}`;
  }

  getSignedMediaUrl(filePath: string) {
    // https://d2jn8gaxpte8na.cloudfront.net/books/BOOK_UUID/FILE_UUID.EXTENSION
    const cloudfrontUrl = this.getCloudfrontUrl(filePath);

    return getSignedUrl({
      url: cloudfrontUrl,
      keyPairId: this.configService.get('cloudfront_key_pair_id'),
      privateKey: this.configService.get('cloudfront_private_key'),
      dateLessThan: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min
    });
  }

  public async s3_requestZippedJson({
    key,
    bucketName,
  }: {
    key: string;
    bucketName: string;
  }): Promise<any> {
    let data: Uint8Array;
    try {
      data = await this.s3_get({
        key,
        bucketName,
      });
    } catch (err) {
      throw new InternalServerError(`Error fetching data for ${key}`, {
        causes: [err],
      });
    }

    let unzippedData: Uint8Array;
    try {
      unzippedData = await this.gunzipPr(data);
    } catch (err) {
      throw new InternalServerError(`Error unzipping data for ${key}`, {
        causes: [err],
      });
    }

    try {
      const jsonData = JSON.parse(unzippedData.toString());
      return jsonData;
    } catch (err) {
      throw new InternalServerError(`Error parsing data for ${key}`, {
        causes: [err],
      });
    }
  }

  /**
   * s3_get
   */
  public async s3_get({
    key,
    bucketName,
  }: {
    key: string;
    bucketName: string;
  }): Promise<Uint8Array> {
    const getObjectCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    const response = await this.s3Client.send(getObjectCommand);
    const data = await response?.Body?.transformToByteArray();

    if (!data) {
      throw new InternalServerError(
        `Request for ${key} has returned undefined for some reason`,
      );
    }

    return data;
  }

  /**
   * s3_getTags
   */
  public async s3_getTags({
    key,
    bucketName,
  }: {
    key: string;
    bucketName: string;
  }): Promise<Record<string, string>> {
    const getObjectTaggingCommand = new GetObjectTaggingCommand({
      Bucket: bucketName,
      Key: key,
    });

    try {
      const response = await this.s3Client.send(getObjectTaggingCommand);
      const tags = response.TagSet?.reduce(
        (acc, tag) => ({
          ...acc,
          [tag.Key ?? '']: tag.Value ?? '',
        }),
        {},
      );

      if (!tags) {
        return {};
      }

      return tags;
    } catch (err) {
      throw new InternalServerError(`Error getting tags for ${key}`, {
        causes: [err],
      });
    }
  }

  /**
   * s3_upload
   */
  public async s3_upload({
    key,
    data,
    bucketName,
    zip = false,
  }: {
    key: string;
    data: any;
    bucketName: string;
    zip?: boolean;
  }) {
    if (zip) {
      data = await this.zipPr(data);
    }

    const parallelUploads3 = new Upload({
      client: this.s3Client,
      params: {
        Bucket: bucketName,
        Key: key,
        Body: data,
      },
      queueSize: 4, // optional concurrency configuration
      partSize: 1024 * 1024 * 5, // optional size of each part, in bytes, at least 5MB
    });

    await parallelUploads3.done();
  }

  public async s3_list({
    bucketName,
    prefix,
  }: {
    bucketName: string;
    prefix: string;
  }): Promise<ListObjectsV2CommandOutput> {
    const listObjectsV2Command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
    });

    const response = await this.s3Client.send(listObjectsV2Command);
    return response;
  }

  public async s3_delete({
    key,
    bucketName,
  }: {
    key: string;
    bucketName: string;
  }) {
    const deleteObjectCommand = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    await this.s3Client.send(deleteObjectCommand);
  }
}

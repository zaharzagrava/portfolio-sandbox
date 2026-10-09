import { Injectable } from '@nestjs/common';
import {
  PutObjectCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { ApiConfigService } from '@app/common/config';
import {
  MultipartUploadInit,
  ObjectStorage,
  PresignedPost,
  PresignPostOptions,
} from './object-storage.port';

@Injectable()
export class S3ObjectStorage extends ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ApiConfigService) {
    super();
    const endpoint = config.get('s3_endpoint');
    const accessKeyId =
      config.get('s3_access_key_id') ?? config.get('aws_access_key_id');
    const secretAccessKey =
      config.get('s3_secret_access_key') ?? config.get('aws_secret_access_key');
    this.bucket = config.get('media_bucket') ?? 'marketplace-media';
    this.client = new S3Client({
      region: config.get('aws_region') || 'eu-central-1',
      // MinIO needs path-style addressing; real S3 uses virtual-hosted style.
      ...(endpoint && { endpoint, forcePathStyle: true }),
      ...(accessKeyId && { credentials: { accessKeyId, secretAccessKey } }),
    });
  }

  /**
   * Presigned POST (not PUT) because its policy can enforce content type and
   * max size server-side - a presigned PUT lets the client upload anything.
   */
  async presignPost({
    key,
    contentTypePrefix,
    maxBytes,
    expiresInSec = 600,
  }: PresignPostOptions): Promise<PresignedPost> {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        ['starts-with', '$Content-Type', contentTypePrefix],
      ],
      Expires: expiresInSec,
    });
    return {
      url,
      fields,
      key,
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    };
  }

  async presignPutChecked(
    key: string,
    sha256Hex: string,
    contentLength: number,
    expiresInSec = 900,
  ) {
    const checksum = Buffer.from(sha256Hex, 'hex').toString('base64');
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ChecksumSHA256: checksum,
        ContentLength: contentLength,
      }),
      // Sign the checksum header so the client can't swap it.
      {
        expiresIn: expiresInSec,
        signableHeaders: new Set(['x-amz-checksum-sha256', 'content-length']),
      },
    );
    return {
      url,
      headers: {
        'x-amz-checksum-sha256': checksum,
        'x-amz-sdk-checksum-algorithm': 'SHA256',
        'content-length': String(contentLength),
      },
    };
  }

  async presignGet(
    key: string,
    {
      expiresInSec = 300,
      downloadName,
    }: { expiresInSec?: number; downloadName?: string } = {},
  ) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // User files are always served as attachments so an uploaded HTML/SVG can't execute as our origin.
        ResponseContentDisposition: `attachment${downloadName ? `; filename="${encodeURIComponent(downloadName)}"` : ''}`,
      }),
      { expiresIn: expiresInSec },
    );
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
    parts: number,
    expiresInSec = 3600,
  ): Promise<MultipartUploadInit> {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    const partUrls = await Promise.all(
      Array.from({ length: parts }, async (_, i) => ({
        partNumber: i + 1,
        url: await getSignedUrl(
          this.client,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId,
            PartNumber: i + 1,
          }),
          { expiresIn: expiresInSec },
        ),
      })),
    );
    return { uploadId: UploadId!, key, partUrls };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string) {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    const { Body } = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return Body as Readable;
  }

  /** Streams (constant memory) via lib-storage's managed multipart upload for large bodies. */
  async put(key: string, body: Buffer | Readable, contentType: string) {
    await new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    }).done();
  }

  async head(key: string) {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: Number(res.ContentLength ?? 0),
        contentType: res.ContentType,
      };
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound') return null;
      throw error;
    }
  }

  async delete(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}

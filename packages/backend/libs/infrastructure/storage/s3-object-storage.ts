import { Injectable } from '@nestjs/common';
import {
  PutObjectCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { ApiConfigService } from '@app/common/config';
import {
  contentTypeCondition,
  MultipartUploadInit,
  ObjectStorage,
  PresignedPost,
  PresignPostOptions,
  PutOptions,
  StorageCallOptions,
  StoredPart,
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
    contentTypes,
    minBytes = 1,
    maxBytes,
    expiresInSec = 600,
  }: PresignPostOptions): Promise<PresignedPost> {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', minBytes, maxBytes],
        contentTypeCondition({ contentTypes, contentTypePrefix }),
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

  async startMultipartUpload(
    key: string,
    contentType: string,
    options: StorageCallOptions = {},
  ) {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      this.abort(options),
    );
    return { uploadId: UploadId! };
  }

  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
    expiresInSec = 3600,
  ) {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
      }),
      { expiresIn: expiresInSec, signableHeaders: new Set(['content-length']) },
    );
  }

  async listParts(
    key: string,
    uploadId: string,
    options: StorageCallOptions = {},
  ): Promise<StoredPart[] | null> {
    const out: StoredPart[] = [];
    let marker: string | undefined;
    try {
      do {
        const res = await this.client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
          this.abort(options),
        );
        for (const p of res.Parts ?? [])
          out.push({
            partNumber: p.PartNumber ?? 0,
            size: Number(p.Size ?? 0),
            etag: p.ETag ?? '',
          });
        marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchUpload') return null;
      throw error;
    }
    return out;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
    options: StorageCallOptions = {},
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
      this.abort(options),
    );
  }

  async abortMultipartUpload(
    key: string,
    uploadId: string,
    options: StorageCallOptions = {},
  ) {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
      this.abort(options),
    );
  }

  async getStream(
    key: string,
    options: StorageCallOptions = {},
  ): Promise<Readable> {
    const { Body } = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      this.abort(options),
    );
    return Body as Readable;
  }

  /**
   * Buffers go in one request (variants, a few hundred KB) with an optional cache header and time limit; streams use
   * lib-storage's managed multipart upload (constant memory) for large bodies.
   */
  async put(
    key: string,
    body: Buffer | Readable,
    contentType: string,
    options: PutOptions = {},
  ) {
    if (Buffer.isBuffer(body)) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ...(options.cacheControl && { CacheControl: options.cacheControl }),
        }),
        this.abort(options),
      );
      return;
    }
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(options.cacheControl && { CacheControl: options.cacheControl }),
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    });
    if (options.timeoutMs)
      AbortSignal.timeout(options.timeoutMs).addEventListener('abort', () => {
        void upload.abort();
      });
    await upload.done();
  }

  private abort({ timeoutMs }: StorageCallOptions) {
    return timeoutMs ? { abortSignal: AbortSignal.timeout(timeoutMs) } : {};
  }

  async head(key: string, options: StorageCallOptions = {}) {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        this.abort(options),
      );
      return {
        size: Number(res.ContentLength ?? 0),
        contentType: res.ContentType,
        cacheControl: res.CacheControl,
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

  async deletePrefix(
    prefix: string,
    options: StorageCallOptions & { limit?: number } = {},
  ) {
    const limit = options.limit ?? 1000;
    let removed = 0;
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: Math.min(1000, limit - removed),
        }),
        this.abort(options),
      );
      const keys = (res.Contents ?? []).flatMap((o) =>
        o.Key ? [{ Key: o.Key }] : [],
      );
      if (keys.length) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys, Quiet: true },
          }),
          this.abort(options),
        );
        removed += keys.length;
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token && removed < limit);
    return removed;
  }

  async list(prefix: string) {
    const out: { key: string; lastModified: Date; size: number }[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? [])
        if (o.Key)
          out.push({
            key: o.Key,
            lastModified: o.LastModified ?? new Date(0),
            size: Number(o.Size ?? 0),
          });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

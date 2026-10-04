import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

export interface StorageOptions {
  endpoint?: string;
  region?: string;
  /** 自建/兼容对象存储一般要求 true；未显式传入时按是否有自定义 endpoint 推断 */
  forcePathStyle?: boolean;
}

export class ObjectStorage {
  private readonly s3: S3Client;
  constructor(private readonly bucket: string, opts: StorageOptions = {}) {
    this.s3 = new S3Client({
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle ?? !!opts.endpoint,
      region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1',
    });
  }

  async *list(prefix: string): AsyncGenerator<{ key: string; size: number; etag: string; lastModified?: Date }> {
    let token: string | undefined;
    do {
      const resp = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of resp.Contents ?? []) {
        if (!o.Key || !o.Key.endsWith('.xlsx')) continue;
        yield {
          key: o.Key,
          size: o.Size ?? 0,
          etag: (o.ETag ?? '').replace(/"/g, ''),
          lastModified: o.LastModified,
        };
      }
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
  }

  async open(key: string): Promise<Readable> {
    const resp = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return resp.Body as Readable;
  }
}


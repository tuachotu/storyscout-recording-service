import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { AudioContentType } from './types.js';

export interface IngestionRecord {
  recordingId: string;
  participantGuid: string;
  participantName: string;
  objectKey: string;
  metadataKey: string;
  originalFilename: string;
  contentType: AudioContentType;
  expectedSizeBytes: number;
  sizeBytes: number | null;
  createdAt: string;
  completedAt: string | null;
  storageState: 'awaitingUpload' | 'ready';
}

export interface IngestionStorage {
  ready(): Promise<void>;
  save(record: IngestionRecord): Promise<void>;
  get(metadataKey: string): Promise<IngestionRecord | null>;
  createUploadUrl(record: IngestionRecord, expiresIn: number): Promise<string>;
  inspectUpload(record: IngestionRecord): Promise<{ sizeBytes: number; contentType?: string }>;
}

export class S3IngestionStorage implements IngestionStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async ready(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async save(record: IngestionRecord): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: record.metadataKey,
        Body: `${JSON.stringify(record, null, 2)}\n`,
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async get(metadataKey: string): Promise<IngestionRecord | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: metadataKey }),
      );
      if (!response.Body) return null;
      return JSON.parse(await response.Body.transformToString()) as IngestionRecord;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404 ||
          (error as { name?: string }).name === 'NoSuchKey')
      )
        return null;
      throw error;
    }
  }

  createUploadUrl(record: IngestionRecord, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: record.objectKey,
        ContentType: record.contentType,
        ServerSideEncryption: 'AES256',
      }),
      { expiresIn },
    );
  }

  async inspectUpload(
    record: IngestionRecord,
  ): Promise<{ sizeBytes: number; contentType?: string }> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: record.objectKey }),
    );
    return response.ContentType
      ? { sizeBytes: response.ContentLength ?? 0, contentType: response.ContentType }
      : { sizeBytes: response.ContentLength ?? 0 };
  }
}

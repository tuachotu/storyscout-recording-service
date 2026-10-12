import type { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from '../errors.js';

export interface BookStorage {
  readText(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  signMedia(key: string): Promise<{ url: string; expiresAt: string }>;
}

export class S3BookStorage implements BookStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async readText(key: string): Promise<string> {
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const limit = 8 * 1024 * 1024;
      if (!object.Body || (object.ContentLength ?? 0) > limit) {
        (object.Body as Readable | undefined)?.destroy();
        throw new AppError(502, 'BOOK_CONTENT_INVALID', 'This book content cannot be displayed.');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > limit)
          throw new AppError(502, 'BOOK_CONTENT_INVALID', 'This book content is too large.');
        chunks.push(Buffer.from(chunk));
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      if (!text.trim())
        throw new AppError(502, 'BOOK_CONTENT_INVALID', 'This book content is empty.');
      return text;
    } catch (error) {
      throw storageError(error);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const object = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return (object.ContentLength ?? 0) > 0;
    } catch (error) {
      const mapped = storageError(error);
      if (mapped.statusCode === 404) return false;
      throw mapped;
    }
  }

  async signMedia(key: string): Promise<{ url: string; expiresAt: string }> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      const seconds = 3600;
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: seconds },
      );
      return { url, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
    } catch (error) {
      throw storageError(error);
    }
  }
}

function storageError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const info = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (
    info?.$metadata?.httpStatusCode === 404 ||
    info?.name === 'NoSuchKey' ||
    info?.name === 'NotFound'
  ) {
    return new AppError(
      404,
      'BOOK_CONTENT_NOT_FOUND',
      'The requested book content is unavailable.',
    );
  }
  return new AppError(
    503,
    'BOOK_STORAGE_UNAVAILABLE',
    'Book content is temporarily unavailable. Please try again.',
  );
}

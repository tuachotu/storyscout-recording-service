import { randomUUID } from 'node:crypto';

import { S3Client } from '@aws-sdk/client-s3';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerBookRoutes } from './books/routes.js';
import { S3BookStorage, type BookStorage } from './books/storage.js';
import { AccessSessions } from './access/sessions.js';
import { loadConfig, type AppConfig } from './config.js';
import { AppError, sendError } from './errors.js';
import { S3IngestionStorage, type IngestionStorage } from './recordings/ingestion-storage.js';
import { registerRecordingRoutes } from './recordings/routes.js';
import type { AudioPreparer } from './transcriptions/preparer.js';
import type { TranscriptionProvider } from './transcriptions/provider.js';

export interface BuildAppOptions {
  config?: AppConfig;
  bookStorage?: BookStorage;
  logger?: boolean;
  ingestionStorage?: IngestionStorage;
  transcriptionProvider?: TranscriptionProvider;
  audioPreparer?: AudioPreparer;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    genReqId: () => `request_${randomUUID()}`,
    logger: options.logger ?? false,
  });
  const origins = new Set(config.webappOrigins ?? [config.webappOrigin]);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || origins.has(origin)),
  });
  await app.register(multipart);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.setNotFoundHandler((request, reply) =>
    sendError(reply, request, 404, 'NOT_FOUND', 'The requested route was not found.'),
  );
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError)
      return sendError(reply, request, error.statusCode, error.code, error.message);
    request.log.error({ error }, 'Request failed');
    return sendError(reply, request, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  });

  const storage =
    options.ingestionStorage ??
    new S3IngestionStorage(
      new S3Client({ region: config.awsRegion ?? 'us-east-1' }),
      config.s3RecordingBucket ?? 'story-scout-recording-bucket',
    );
  const sessions = new AccessSessions(
    config.participants ?? [],
    config.sessionSigningSecret ?? 'local-development-secret-change-me',
    config.sessionLifetimeSeconds ?? 21_600,
  );

  app.get('/api/v1/health', async () => ({ status: 'ok' as const }));
  app.get('/api/v1/ready', async (_request, reply) => {
    try {
      await storage.ready();
      return reply.send({ status: 'ready' as const });
    } catch {
      return reply.status(503).send({ status: 'not-ready' as const });
    }
  });
  await registerRecordingRoutes(app, {
    sessions,
    storage,
    maxAudioBytes: config.maxAudioBytes,
    uploadUrlSeconds: config.uploadUrlSeconds ?? 900,
    recordingPrefix: config.recordingPrefix ?? 'recordings',
  });
  registerBookRoutes(
    app,
    options.bookStorage ??
      new S3BookStorage(
        new S3Client({ region: config.awsRegion ?? 'us-east-1' }),
        config.s3BookBucket ?? config.s3RecordingBucket ?? 'story-scout-recording-bucket',
      ),
    config.bookPrefix ?? 'books',
  );
  return app;
}

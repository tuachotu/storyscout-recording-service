import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AccessSessions, Participant } from '../access/sessions.js';
import { AppError } from '../errors.js';
import type { IngestionRecord, IngestionStorage } from './ingestion-storage.js';
import { AudioContentTypeSchema, RecordingIdSchema } from './types.js';

const AccessBodySchema = z.object({ guid: z.uuid() });
const CreateBodySchema = z.object({
  originalFilename: z.string().min(1).max(255),
  contentType: z
    .string()
    .transform((value) => value.split(';', 1)[0]?.trim().toLowerCase())
    .pipe(AudioContentTypeSchema),
  sizeBytes: z.number().int().positive(),
});
const ParamsSchema = z.object({ recordingId: RecordingIdSchema });

export interface RecordingRouteOptions {
  sessions: AccessSessions;
  storage: IngestionStorage;
  maxAudioBytes: number;
  uploadUrlSeconds: number;
  recordingPrefix: string;
}

export async function registerRecordingRoutes(
  app: FastifyInstance,
  options: RecordingRouteOptions,
): Promise<void> {
  app.post('/api/v1/access-sessions', async (request, reply) => {
    const parsed = AccessBodySchema.safeParse(request.body);
    if (!parsed.success)
      throw new AppError(400, 'INVALID_REQUEST', 'A valid access code is required.');
    return reply.status(201).send(options.sessions.issue(parsed.data.guid));
  });

  app.post('/api/v1/recordings', async (request, reply) => {
    const participant = authenticate(request, options.sessions);
    const parsed = CreateBodySchema.safeParse(request.body);
    if (!parsed.success)
      throw new AppError(400, 'INVALID_REQUEST', 'Valid recording details are required.');
    if (parsed.data.sizeBytes > options.maxAudioBytes) {
      throw new AppError(413, 'AUDIO_TOO_LARGE', 'The audio exceeds the upload limit.');
    }
    const recordingId = `recording_${randomUUID().replaceAll('-', '')}`;
    const baseKey = `${trim(options.recordingPrefix)}/${participant.guid}/${recordingId}`;
    const record: IngestionRecord = {
      recordingId,
      participantGuid: participant.guid,
      participantName: participant.displayName,
      objectKey: `${baseKey}/original.${extensionFor(parsed.data.contentType)}`,
      metadataKey: `${baseKey}/metadata.json`,
      originalFilename: parsed.data.originalFilename.split(/[\\/]/).at(-1) ?? 'recording',
      contentType: parsed.data.contentType,
      expectedSizeBytes: parsed.data.sizeBytes,
      sizeBytes: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      storageState: 'awaitingUpload',
    };
    await options.storage.save(record);
    const uploadUrl = await options.storage.createUploadUrl(record, options.uploadUrlSeconds);
    return reply
      .status(201)
      .header('location', `/api/v1/recordings/${recordingId}`)
      .send({
        recording: present(record),
        upload: {
          url: uploadUrl,
          method: 'PUT',
          headers: { 'Content-Type': record.contentType, 'x-amz-server-side-encryption': 'AES256' },
          expiresAt: new Date(Date.now() + options.uploadUrlSeconds * 1000).toISOString(),
        },
      });
  });

  app.get('/api/v1/recordings/:recordingId', async (request, reply) => {
    const participant = authenticate(request, options.sessions);
    return reply.send(present(await findOwned(request.params, participant, options)));
  });

  app.get('/api/v1/recordings/:recordingId/transcription', async (request, reply) => {
    const participant = authenticate(request, options.sessions);
    const recording = await findOwned(request.params, participant, options);
    if (recording.storageState !== 'ready') {
      throw new AppError(409, 'RECORDING_NOT_READY', 'The recording upload is not complete.');
    }
    const text = await options.storage.getTranscription(recording);
    if (text === null) {
      throw new AppError(404, 'TRANSCRIPTION_NOT_FOUND', 'The transcription was not found.');
    }
    return reply.send({ recording: present(recording), transcription: { text } });
  });

  app.post('/api/v1/recordings/:recordingId/complete', async (request, reply) => {
    const participant = authenticate(request, options.sessions);
    const recording = await findOwned(request.params, participant, options);
    if (recording.storageState === 'ready') return reply.send(present(recording));
    let upload: { sizeBytes: number; contentType?: string };
    try {
      upload = await options.storage.inspectUpload(recording);
    } catch {
      throw new AppError(409, 'UPLOAD_NOT_FOUND', 'The recording upload has not completed.');
    }
    if (upload.sizeBytes !== recording.expectedSizeBytes) {
      throw new AppError(
        409,
        'UPLOAD_SIZE_MISMATCH',
        'The uploaded recording size does not match.',
      );
    }
    if (upload.contentType && upload.contentType !== recording.contentType) {
      throw new AppError(
        409,
        'UPLOAD_TYPE_MISMATCH',
        'The uploaded recording format does not match.',
      );
    }
    recording.storageState = 'ready';
    recording.sizeBytes = upload.sizeBytes;
    recording.completedAt = new Date().toISOString();
    await options.storage.save(recording);
    return reply.send(present(recording));
  });
}

function authenticate(request: FastifyRequest, sessions: AccessSessions): Participant {
  const value = request.headers.authorization;
  return sessions.verify(value?.startsWith('Bearer ') ? value.slice(7) : undefined);
}

async function findOwned(
  params: unknown,
  participant: Participant,
  options: RecordingRouteOptions,
): Promise<IngestionRecord> {
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) throw new AppError(400, 'INVALID_REQUEST', 'The recording ID is invalid.');
  const key = `${trim(options.recordingPrefix)}/${participant.guid}/${parsed.data.recordingId}/metadata.json`;
  const record = await options.storage.get(key);
  if (!record || record.participantGuid !== participant.guid) {
    throw new AppError(404, 'RECORDING_NOT_FOUND', 'The recording was not found.');
  }
  return record;
}

function present(record: IngestionRecord) {
  return {
    recordingId: record.recordingId,
    participantName: record.participantName,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    storageState: record.storageState,
    originalFilename: record.originalFilename,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
  };
}

function extensionFor(contentType: z.infer<typeof AudioContentTypeSchema>): string {
  if (contentType === 'audio/mp4') return 'm4a';
  if (contentType === 'audio/mpeg') return 'mp3';
  if (contentType === 'audio/wav' || contentType === 'audio/x-wav') return 'wav';
  return 'webm';
}

function trim(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors.js';
import type { AudioStorage } from '../recordings/storage.js';
import { AudioContentTypeSchema, RecordingIdSchema } from '../recordings/types.js';
import type { LocalTranscriptionStorage } from './storage.js';
import { TranscriptionIdSchema } from './types.js';
import type { TranscriptionWorker } from './worker.js';

const ParamsSchema = z.object({ transcriptionId: TranscriptionIdSchema });
const CreateSchema = z.object({ recordingId: RecordingIdSchema }).strict();
const QuerySchema = z.object({ format: z.enum(['json', 'text']).default('json') });

export async function registerTranscriptionRoutes(
  app: FastifyInstance,
  options: {
    audioStorage: AudioStorage;
    storage: LocalTranscriptionStorage;
    worker: TranscriptionWorker;
    modelId: string;
    maxAudioBytes: number;
  },
): Promise<void> {
  app.post('/api/v1/transcriptions', async (request, reply) => {
    let recordingId: string;
    if (request.isMultipart()) {
      const file = await request.file();
      if (!file) throw new AppError(400, 'INVALID_REQUEST', 'One audio file is required.');
      const contentType = AudioContentTypeSchema.safeParse(file.mimetype);
      if (!contentType.success) {
        file.file.resume();
        throw new AppError(
          415,
          'UNSUPPORTED_AUDIO_FORMAT',
          'The selected audio format is not supported.',
        );
      }
      const recording = await options.audioStorage.createRecording();
      const saved = await options.audioStorage.saveAudio(recording.recordingId, {
        contentType: contentType.data,
        maxBytes: options.maxAudioBytes,
        originalFilename: file.filename,
        stream: file.file,
      });
      recordingId = saved.recordingId;
    } else {
      const parsed = CreateSchema.safeParse(request.body);
      if (!parsed.success)
        throw new AppError(400, 'INVALID_REQUEST', 'A valid recording ID is required.');
      const recording = await options.audioStorage.getRecording(parsed.data.recordingId);
      if (!recording || recording.storageState !== 'ready') {
        throw new AppError(404, 'RECORDING_NOT_FOUND', 'A ready recording was not found.');
      }
      recordingId = recording.recordingId;
    }

    const job = await options.storage.create(recordingId, options.modelId);
    options.worker.enqueue(job.transcriptionId);
    return reply.status(202).header('location', job.statusUrl).send(job);
  });

  app.get('/api/v1/transcriptions/:transcriptionId', async (request, reply) => {
    const { transcriptionId } = parseParams(request.params);
    const job = await options.storage.get(transcriptionId);
    if (!job)
      throw new AppError(404, 'TRANSCRIPTION_NOT_FOUND', 'The transcription was not found.');
    return reply.send(job);
  });

  app.get('/api/v1/transcriptions/:transcriptionId/transcript', async (request, reply) => {
    const { transcriptionId } = parseParams(request.params);
    const query = QuerySchema.safeParse(request.query);
    if (!query.success)
      throw new AppError(400, 'INVALID_REQUEST', 'The transcript format is invalid.');
    const job = await options.storage.get(transcriptionId);
    if (!job)
      throw new AppError(404, 'TRANSCRIPTION_NOT_FOUND', 'The transcription was not found.');
    if (job.state !== 'completed') {
      throw new AppError(409, 'TRANSCRIPTION_NOT_COMPLETE', 'The transcript is not available yet.');
    }
    const transcript = await options.storage.getTranscript(transcriptionId);
    if (!transcript)
      throw new AppError(500, 'INTERNAL_ERROR', 'The completed transcript is unavailable.');
    if (query.data.format === 'text')
      return reply.type('text/plain; charset=utf-8').send(transcript.text);
    return reply.send(transcript);
  });

  app.post('/api/v1/transcriptions/:transcriptionId/retry', async (request, reply) => {
    const { transcriptionId } = parseParams(request.params);
    const job = await options.storage.get(transcriptionId);
    if (!job)
      throw new AppError(404, 'TRANSCRIPTION_NOT_FOUND', 'The transcription was not found.');
    if (job.state !== 'failed') {
      throw new AppError(
        409,
        'TRANSCRIPTION_NOT_FAILED',
        'Only a failed transcription can be retried.',
      );
    }
    const queued = { ...job, state: 'queued' as const, attempt: job.attempt + 1, error: null };
    await options.storage.update(queued);
    options.worker.enqueue(transcriptionId);
    return reply.status(202).send(queued);
  });
}

function parseParams(value: unknown): z.infer<typeof ParamsSchema> {
  const result = ParamsSchema.safeParse(value);
  if (!result.success)
    throw new AppError(400, 'INVALID_REQUEST', 'The transcription ID is invalid.');
  return result.data;
}

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { LocalFileAudioStorage } from '../src/recordings/local-file-audio-storage.js';
import {
  AudioPreparationError,
  type AudioPreparer,
  type PreparedAudio,
} from '../src/transcriptions/preparer.js';
import type {
  TranscriptionProvider,
  TranscriptionProviderResult,
} from '../src/transcriptions/provider.js';
import { LocalTranscriptionStorage } from '../src/transcriptions/storage.js';

const apps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('local transcription REST API', () => {
  it('transcribes an existing recording and returns JSON and text', async () => {
    const provider = new FakeProvider([{ text: 'नमस्ते दुनिया', detectedLanguages: ['hi'] }]);
    const { app } = await createTestApp(provider);
    const recordingId = await createReadyRecording(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/transcriptions',
      payload: { recordingId },
    });
    expect(created.statusCode).toBe(202);
    expect(created.headers.location).toMatch(/^\/api\/v1\/transcriptions\/transcription_/);
    const job = await waitForState(app, created.json().transcriptionId, 'completed');
    expect(job).toMatchObject({
      recordingId,
      detectedLanguages: ['hi'],
      modelId: 'gpt-transcribe',
    });

    const json = await app.inject({ method: 'GET', url: `${job.transcriptUrl}?format=json` });
    expect(json.statusCode).toBe(200);
    expect(json.json()).toMatchObject({
      recordingId,
      text: 'नमस्ते दुनिया',
      detectedLanguages: ['hi'],
      version: 1,
    });
    expect(json.json()).not.toHaveProperty('segments');
    expect(json.json()).not.toHaveProperty('translation');
    expect(json.json()).not.toHaveProperty('summary');

    const text = await app.inject({ method: 'GET', url: `${job.transcriptUrl}?format=text` });
    expect(text.statusCode).toBe(200);
    expect(text.body).toBe('नमस्ते दुनिया');
    expect(text.headers['content-type']).toContain('text/plain');
  });

  it('accepts a direct local audio upload and creates its technical recording', async () => {
    const provider = new FakeProvider([{ text: 'direct transcript', detectedLanguages: ['en'] }]);
    const { app } = await createTestApp(provider);
    const audio = createWav();
    const response = await uploadMultipart(app, '/api/v1/transcriptions', audio);

    expect(response.statusCode).toBe(202);
    const completed = await waitForState(app, response.json().transcriptionId, 'completed');
    expect(completed.recordingId).toMatch(/^recording_/);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/recordings/${completed.recordingId}`,
        })
      ).json(),
    ).toMatchObject({ storageState: 'ready', sizeBytes: audio.length });
  });

  it('stores a safe failure and retries the same job', async () => {
    const provider = new FakeProvider([
      new Error('private provider details'),
      { text: 'retry succeeded', detectedLanguages: ['en'] },
    ]);
    const { app } = await createTestApp(provider);
    const recordingId = await createReadyRecording(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/transcriptions',
      payload: { recordingId },
    });
    const failed = await waitForState(app, created.json().transcriptionId, 'failed');
    expect(failed.error).toEqual({
      code: 'TRANSCRIPTION_PROVIDER_ERROR',
      message: 'The transcription provider could not complete the request.',
      retryable: true,
    });
    expect(JSON.stringify(failed)).not.toContain('private provider details');

    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/transcriptions/${failed.transcriptionId}/retry`,
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json().attempt).toBe(2);
    expect((await waitForState(app, failed.transcriptionId, 'completed')).attempt).toBe(2);
  });

  it('reports preparation failure safely and never calls the provider', async () => {
    const provider = new FakeProvider([]);
    const preparer: AudioPreparer = {
      prepare: async () => {
        throw new AudioPreparationError('private ffmpeg diagnostics');
      },
    };
    const { app } = await createTestApp(provider, preparer);
    const recordingId = await createReadyRecording(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/transcriptions',
      payload: { recordingId },
    });

    const failed = await waitForState(app, created.json().transcriptionId, 'failed');
    expect(failed.error).toEqual({
      code: 'AUDIO_PREPARATION_FAILED',
      message: 'The source audio could not be prepared safely for transcription.',
      retryable: true,
    });
    expect(provider.paths).toEqual([]);
    expect(JSON.stringify(failed)).not.toContain('private ffmpeg diagnostics');
  });

  it('assembles prepared chunks in chronological order and cleans them', async () => {
    const provider = new FakeProvider([
      { text: 'first', detectedLanguages: ['en'] },
      { text: 'second', detectedLanguages: ['en'] },
    ]);
    const preparer = new FakeChunkPreparer();
    const { app } = await createTestApp(provider, preparer);
    const recordingId = await createReadyRecording(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/transcriptions',
      payload: { recordingId },
    });
    const completed = await waitForState(app, created.json().transcriptionId, 'completed');
    const transcript = await app.inject({ method: 'GET', url: completed.transcriptUrl });
    expect(transcript.json().text).toBe('first\n\nsecond');
    expect(provider.paths.map((filePath) => basename(filePath))).toEqual([
      'chunk-0000.mp3',
      'chunk-0001.mp3',
    ]);
    expect(preparer.cleaned).toBe(true);
  });

  it('validates unavailable work and recovers an interrupted job after restart', async () => {
    const provider = new FakeProvider([{ text: 'recovered', detectedLanguages: ['en'] }]);
    const dataDirectory = await makeTemporaryDirectory();
    const audioStorage = new LocalFileAudioStorage(dataDirectory);
    const recording = await audioStorage.createRecording();
    await audioStorage.saveAudio(recording.recordingId, {
      contentType: 'audio/wav',
      maxBytes: 1_000_000,
      originalFilename: 'restart.wav',
      stream: Readable.from(createWav()),
    });
    const transcriptionStorage = new LocalTranscriptionStorage(dataDirectory);
    const interrupted = await transcriptionStorage.create(recording.recordingId, 'gpt-transcribe');
    await transcriptionStorage.update({ ...interrupted, state: 'processing' });

    const app = await buildConfiguredApp(dataDirectory, provider);
    expect((await waitForState(app, interrupted.transcriptionId, 'completed')).state).toBe(
      'completed',
    );

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/transcriptions',
      payload: { recordingId: 'recording_missing' },
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/transcriptions/not-valid!',
    });
    expect(invalid.statusCode).toBe(400);
    const retryComplete = await app.inject({
      method: 'POST',
      url: `/api/v1/transcriptions/${interrupted.transcriptionId}/retry`,
    });
    expect(retryComplete.statusCode).toBe(409);
  });
});

class FakeProvider implements TranscriptionProvider {
  readonly paths: string[] = [];
  constructor(private readonly results: (TranscriptionProviderResult | Error)[]) {}
  async transcribe(filePath: string): Promise<TranscriptionProviderResult> {
    this.paths.push(filePath);
    const result = this.results.shift();
    if (!result) throw new Error('No fake result configured');
    if (result instanceof Error) throw result;
    return result;
  }
}

class FakeChunkPreparer implements AudioPreparer {
  cleaned = false;
  async prepare(_sourcePath: string, workDirectory: string): Promise<PreparedAudio> {
    const first = join(workDirectory, 'chunk-0000.mp3');
    const second = join(workDirectory, 'chunk-0001.mp3');
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    return {
      files: [first, second],
      cleanup: async () => {
        this.cleaned = true;
      },
    };
  }
}

async function createTestApp(provider: TranscriptionProvider, preparer?: AudioPreparer) {
  const dataDirectory = await makeTemporaryDirectory();
  const app = await buildConfiguredApp(dataDirectory, provider, preparer);
  return { app, dataDirectory };
}

async function buildConfiguredApp(
  dataDirectory: string,
  provider: TranscriptionProvider,
  preparer?: AudioPreparer,
) {
  const options = {
    config: {
      host: '127.0.0.1',
      port: 3001,
      webappOrigin: 'http://localhost:5173',
      localDataDirectory: dataDirectory,
      maxAudioBytes: 1_000_000,
      openAiTranscriptionModel: 'gpt-transcribe',
      transcriptionConcurrency: 1,
      openAiAudioRequestLimitBytes: 25_000_000,
    },
    transcriptionProvider: provider,
    ...(preparer ? { audioPreparer: preparer } : {}),
  };
  const app = await buildApp(options);
  apps.push(app);
  return app;
}

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'storyscout-transcriptions-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createReadyRecording(app: FastifyInstance): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/v1/recordings' });
  const recordingId = created.json().recordingId as string;
  expect(
    (await uploadMultipart(app, `/api/v1/recordings/${recordingId}/audio`, createWav())).statusCode,
  ).toBe(201);
  return recordingId;
}

async function uploadMultipart(app: FastifyInstance, url: string, audio: Buffer) {
  const boundary = 'storyscout-transcription-boundary';
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
  );
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([prefix, audio, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  });
}

async function waitForState(app: FastifyInstance, id: string, state: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/v1/transcriptions/${id}` });
    const job = response.json();
    if (job.state === state) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Transcription ${id} did not reach ${state}`);
}

function createWav(): Buffer {
  const sampleRate = 8_000;
  const dataSize = 800 * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

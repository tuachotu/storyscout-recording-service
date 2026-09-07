import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { IngestionRecord, IngestionStorage } from '../src/recordings/ingestion-storage.js';

const GUID = '11111111-1111-4111-8111-111111111111';
const OTHER_GUID = '22222222-2222-4222-8222-222222222222';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('recording ingestion module', () => {
  it('validates a participant without returning their GUID', async () => {
    const { app } = await createApp();
    const issuedAt = Date.now();
    const valid = await access(app, GUID);
    expect(valid.statusCode).toBe(201);
    expect(valid.json()).toMatchObject({ displayName: 'Pilot One' });
    const lifetimeMilliseconds = Date.parse(valid.json().expiresAt as string) - issuedAt;
    expect(lifetimeMilliseconds).toBeGreaterThanOrEqual(21_599_000);
    expect(lifetimeMilliseconds).toBeLessThanOrEqual(21_600_000);
    expect(valid.body).not.toContain(GUID);
    expect((await access(app, '33333333-3333-4333-8333-333333333333')).statusCode).toBe(401);
  });

  it('requires access and creates a participant-scoped presigned upload', async () => {
    const { app, storage } = await createApp();
    expect((await createRecording(app)).statusCode).toBe(401);
    const response = await createRecording(
      app,
      await tokenFor(app, GUID),
      'audio/webm;codecs=opus',
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      recording: { participantName: 'Pilot One', storageState: 'awaitingUpload' },
      upload: { method: 'PUT' },
    });
    expect(response.json().recording.contentType).toBe('audio/webm');
    expect(response.json().upload.headers['Content-Type']).toBe('audio/webm');
    expect(response.body).not.toContain(GUID);
    expect([...storage.records.values()][0]?.objectKey).toMatch(
      new RegExp(`^recordings/${GUID}/recording_.+/original.webm$`),
    );
  });

  it('verifies S3 before completing and makes completion idempotent', async () => {
    const { app, storage } = await createApp();
    const token = await tokenFor(app, GUID);
    const id = (await createRecording(app, token)).json().recording.recordingId as string;
    expect((await complete(app, id, token)).json().error.code).toBe('UPLOAD_NOT_FOUND');
    storage.uploads.set(id, { sizeBytes: 5, contentType: 'audio/webm' });
    const completed = await complete(app, id, token);
    expect(completed.json()).toMatchObject({
      recordingId: id,
      storageState: 'ready',
      sizeBytes: 5,
    });
    expect((await complete(app, id, token)).json()).toEqual(completed.json());
  });

  it('rejects mismatched uploads and cross-participant access', async () => {
    const { app, storage } = await createApp();
    const owner = await tokenFor(app, GUID);
    const id = (await createRecording(app, owner)).json().recording.recordingId as string;
    storage.uploads.set(id, { sizeBytes: 4, contentType: 'audio/webm' });
    expect((await complete(app, id, owner)).json().error.code).toBe('UPLOAD_SIZE_MISMATCH');
    const other = await tokenFor(app, OTHER_GUID);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/recordings/${id}`, headers: bearer(other) }))
        .statusCode,
    ).toBe(404);
  });

  it('reports readiness from S3', async () => {
    const { app, storage } = await createApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/ready' })).json()).toEqual({
      status: 'ready',
    });
    storage.isReady = false;
    expect((await app.inject({ method: 'GET', url: '/api/v1/ready' })).statusCode).toBe(503);
  });
});

class MemoryStorage implements IngestionStorage {
  records = new Map<string, IngestionRecord>();
  uploads = new Map<string, { sizeBytes: number; contentType?: string }>();
  isReady = true;
  async ready() {
    if (!this.isReady) throw new Error('unavailable');
  }
  async save(record: IngestionRecord) {
    this.records.set(record.metadataKey, structuredClone(record));
  }
  async get(key: string) {
    return this.records.has(key) ? structuredClone(this.records.get(key)!) : null;
  }
  async createUploadUrl(record: IngestionRecord) {
    return `https://upload.test/${record.recordingId}`;
  }
  async inspectUpload(record: IngestionRecord) {
    const upload = this.uploads.get(record.recordingId);
    if (!upload) throw new Error('missing');
    return upload;
  }
}

async function createApp() {
  const storage = new MemoryStorage();
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 3001,
    webappOrigin: 'http://localhost:5173',
    webappOrigins: ['http://localhost:5173'],
    localDataDirectory: '.local-data',
    maxAudioBytes: 100,
    openAiTranscriptionModel: 'gpt-transcribe',
    transcriptionConcurrency: 1,
    openAiAudioRequestLimitBytes: 25_000_000,
    participants: [
      { guid: GUID, displayName: 'Pilot One' },
      { guid: OTHER_GUID, displayName: 'Pilot Two' },
    ],
    sessionSigningSecret: 'a-test-secret-that-is-at-least-32-characters',
    sessionLifetimeSeconds: 21_600,
    uploadUrlSeconds: 900,
    recordingPrefix: 'recordings',
    awsRegion: 'us-east-1',
    s3RecordingBucket: 'test-bucket',
  };
  const app = await buildApp({ config, ingestionStorage: storage });
  apps.push(app);
  return { app, storage };
}

function access(app: FastifyInstance, guid: string) {
  return app.inject({ method: 'POST', url: '/api/v1/access-sessions', payload: { guid } });
}
async function tokenFor(app: FastifyInstance, guid: string) {
  return (await access(app, guid)).json().accessToken as string;
}
function createRecording(app: FastifyInstance, token?: string, contentType = 'audio/webm') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/recordings',
    headers: token ? bearer(token) : {},
    payload: { originalFilename: 'story.webm', contentType, sizeBytes: 5 },
  });
}
function complete(app: FastifyInstance, id: string, token: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/recordings/${id}/complete`,
    headers: bearer(token),
  });
}
function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

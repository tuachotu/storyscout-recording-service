import { resolve } from 'node:path';

import { z } from 'zod';

const ConfigSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEBAPP_ORIGIN: z.url().default('http://localhost:5173'),
  WEBAPP_ORIGINS: z.string().optional(),
  LOCAL_DATA_DIRECTORY: z.string().min(1).default('.local-data'),
  MAX_AUDIO_BYTES: z.coerce.number().int().positive().default(524_288_000),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_TRANSCRIPTION_MODEL: z.string().min(1).default('gpt-transcribe'),
  TRANSCRIPTION_CONCURRENCY: z.coerce.number().int().positive().default(1),
  OPENAI_AUDIO_REQUEST_LIMIT_BYTES: z.coerce.number().int().positive().default(25_000_000),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  S3_RECORDING_BUCKET: z.string().min(3).default('story-scout-recording-bucket'),
  S3_BOOK_BUCKET: z.string().min(3).optional(),
  BOOK_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/)
    .default('books'),
  RECORDING_PREFIX: z.string().min(1).default('recordings'),
  PARTICIPANTS_JSON: z.string().default('[]'),
  SESSION_SIGNING_SECRET: z.string().min(32).default('local-development-secret-change-me'),
  SESSION_LIFETIME_SECONDS: z.coerce.number().int().positive().default(21_600),
  UPLOAD_URL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
});

export interface AppConfig {
  host: string;
  port: number;
  webappOrigin: string;
  webappOrigins?: string[];
  localDataDirectory: string;
  maxAudioBytes: number;
  openAiApiKey?: string;
  openAiTranscriptionModel: string;
  transcriptionConcurrency: number;
  openAiAudioRequestLimitBytes: number;
  awsRegion?: string;
  s3RecordingBucket?: string;
  recordingPrefix?: string;
  s3BookBucket?: string;
  bookPrefix?: string;
  participants?: Array<{ guid: string; displayName: string }>;
  sessionSigningSecret?: string;
  sessionLifetimeSeconds?: number;
  uploadUrlSeconds?: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.parse(environment);
  const participants = z
    .array(z.object({ guid: z.uuid(), displayName: z.string().min(1) }))
    .parse(JSON.parse(parsed.PARTICIPANTS_JSON));
  if (
    environment.NODE_ENV === 'production' &&
    parsed.SESSION_SIGNING_SECRET === 'local-development-secret-change-me'
  ) {
    throw new Error('SESSION_SIGNING_SECRET must be configured in production.');
  }
  if (environment.NODE_ENV === 'production' && participants.length === 0) {
    throw new Error('PARTICIPANTS_JSON must contain at least one participant in production.');
  }

  const config: AppConfig = {
    host: parsed.HOST,
    port: parsed.PORT,
    webappOrigin: parsed.WEBAPP_ORIGIN,
    webappOrigins: (parsed.WEBAPP_ORIGINS ?? `${parsed.WEBAPP_ORIGIN},https://vikrant.info`)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    localDataDirectory: resolve(parsed.LOCAL_DATA_DIRECTORY),
    maxAudioBytes: parsed.MAX_AUDIO_BYTES,
    openAiTranscriptionModel: parsed.OPENAI_TRANSCRIPTION_MODEL,
    transcriptionConcurrency: parsed.TRANSCRIPTION_CONCURRENCY,
    openAiAudioRequestLimitBytes: parsed.OPENAI_AUDIO_REQUEST_LIMIT_BYTES,
    awsRegion: parsed.AWS_REGION,
    s3RecordingBucket: parsed.S3_RECORDING_BUCKET,
    recordingPrefix: parsed.RECORDING_PREFIX,
    s3BookBucket: parsed.S3_BOOK_BUCKET ?? parsed.S3_RECORDING_BUCKET,
    bookPrefix: parsed.BOOK_PREFIX,
    participants,
    sessionSigningSecret: parsed.SESSION_SIGNING_SECRET,
    sessionLifetimeSeconds: parsed.SESSION_LIFETIME_SECONDS,
    uploadUrlSeconds: parsed.UPLOAD_URL_SECONDS,
  };
  if (parsed.OPENAI_API_KEY) config.openAiApiKey = parsed.OPENAI_API_KEY;
  return config;
}

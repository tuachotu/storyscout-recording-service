import { z } from 'zod';

import { RecordingIdSchema } from '../recordings/types.js';

export const TranscriptionIdSchema = z.string().regex(/^transcription_[A-Za-z0-9_-]+$/);
export const TranscriptionStateSchema = z.enum(['queued', 'processing', 'completed', 'failed']);

export const TranscriptionFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

export const TranscriptionJobSchema = z.object({
  transcriptionId: TranscriptionIdSchema,
  recordingId: RecordingIdSchema,
  state: TranscriptionStateSchema,
  attempt: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  modelId: z.string(),
  detectedLanguages: z.array(z.string()),
  statusUrl: z.string(),
  transcriptUrl: z.string().nullable(),
  error: TranscriptionFailureSchema.nullable(),
});

export const TranscriptSchema = z.object({
  transcriptionId: TranscriptionIdSchema,
  recordingId: RecordingIdSchema,
  text: z.string(),
  detectedLanguages: z.array(z.string()),
  version: z.number().int().positive(),
  modelId: z.string(),
  createdAt: z.iso.datetime(),
});

export type TranscriptionJob = z.infer<typeof TranscriptionJobSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;

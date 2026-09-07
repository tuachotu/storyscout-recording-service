import { z } from 'zod';

export const RecordingIdSchema = z.string().regex(/^recording_[A-Za-z0-9_-]+$/);

export const AudioContentTypeSchema = z.enum([
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
]);

export const RecordingSchema = z.object({
  recordingId: RecordingIdSchema,
  createdAt: z.iso.datetime(),
  storageState: z.enum(['awaitingAudio', 'ready']),
  originalFilename: z.string().nullable(),
  contentType: AudioContentTypeSchema.nullable(),
  sizeBytes: z.number().int().positive().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  checksumSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});

export type AudioContentType = z.infer<typeof AudioContentTypeSchema>;
export type Recording = z.infer<typeof RecordingSchema>;

import type { Readable } from 'node:stream';

import type { AudioContentType, Recording } from './types.js';

export interface AudioUpload {
  contentType: AudioContentType;
  maxBytes: number;
  originalFilename: string;
  stream: Readable;
}

export interface StoredAudio {
  contentType: AudioContentType;
  filePath: string;
  sizeBytes: number;
}

export interface AudioStorage {
  createRecording(): Promise<Recording>;
  getRecording(recordingId: string): Promise<Recording | null>;
  saveAudio(recordingId: string, upload: AudioUpload): Promise<Recording>;
  openAudio(recordingId: string): Promise<StoredAudio | null>;
}

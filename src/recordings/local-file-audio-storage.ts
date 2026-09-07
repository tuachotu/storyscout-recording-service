import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

import { AppError } from '../errors.js';
import { FfprobeAudioProbe, type AudioProbe } from './audio-probe.js';
import type { AudioStorage, AudioUpload, StoredAudio } from './storage.js';
import {
  AudioContentTypeSchema,
  RecordingIdSchema,
  RecordingSchema,
  type AudioContentType,
  type Recording,
} from './types.js';

const extensionByContentType: Record<AudioContentType, string> = {
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
};

export class LocalFileAudioStorage implements AudioStorage {
  constructor(
    private readonly rootDirectory: string,
    private readonly audioProbe: AudioProbe = new FfprobeAudioProbe(),
  ) {}

  async createRecording(): Promise<Recording> {
    const recordingId = `recording_${randomUUID().replaceAll('-', '')}`;
    const directory = this.recordingDirectory(recordingId);
    await mkdir(directory, { recursive: true });

    const recording: Recording = {
      recordingId,
      createdAt: new Date().toISOString(),
      storageState: 'awaitingAudio',
      originalFilename: null,
      contentType: null,
      sizeBytes: null,
      durationSeconds: null,
      checksumSha256: null,
    };
    await this.writeRecording(recording);
    return recording;
  }

  async getRecording(recordingId: string): Promise<Recording | null> {
    if (!RecordingIdSchema.safeParse(recordingId).success) return null;

    try {
      const contents = await readFile(this.recordingFile(recordingId), 'utf8');
      return RecordingSchema.parse(JSON.parse(contents));
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveAudio(recordingId: string, upload: AudioUpload): Promise<Recording> {
    const recording = await this.getRecording(recordingId);
    if (!recording) {
      throw new AppError(404, 'RECORDING_NOT_FOUND', 'The recording was not found.');
    }
    if (recording.storageState === 'ready') {
      throw new AppError(
        409,
        'RECORDING_AUDIO_EXISTS',
        'Audio has already been stored for this recording.',
      );
    }

    const contentType = AudioContentTypeSchema.parse(upload.contentType);
    const sourceDirectory = join(this.recordingDirectory(recordingId), 'source');
    await mkdir(sourceDirectory, { recursive: true });
    const temporaryFile = join(sourceDirectory, `.upload-${randomUUID()}`);
    const finalFile = join(sourceDirectory, `original.${extensionByContentType[contentType]}`);
    const hash = createHash('sha256');
    let sizeBytes = 0;

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > upload.maxBytes) {
          callback(new AppError(413, 'AUDIO_TOO_LARGE', 'The audio exceeds the upload limit.'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(upload.stream, meter, createWriteStream(temporaryFile, { flags: 'wx' }));
      if (sizeBytes === 0) {
        throw new AppError(400, 'INVALID_REQUEST', 'The audio file is empty.');
      }

      let durationSeconds: number;
      try {
        ({ durationSeconds } = await this.audioProbe.probe(temporaryFile));
      } catch {
        throw new AppError(
          415,
          'UNSUPPORTED_AUDIO_FORMAT',
          'The selected audio format is not supported.',
        );
      }

      try {
        await link(temporaryFile, finalFile);
      } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
          throw new AppError(
            409,
            'RECORDING_AUDIO_EXISTS',
            'Audio has already been stored for this recording.',
          );
        }
        throw error;
      }
      await unlink(temporaryFile);

      const updated: Recording = {
        ...recording,
        storageState: 'ready',
        originalFilename: basename(upload.originalFilename),
        contentType,
        sizeBytes,
        durationSeconds,
        checksumSha256: hash.digest('hex'),
      };
      await this.writeRecording(updated);
      return updated;
    } catch (error) {
      await unlink(temporaryFile).catch(() => undefined);
      throw error;
    }
  }

  async openAudio(recordingId: string): Promise<StoredAudio | null> {
    const recording = await this.getRecording(recordingId);
    if (!recording || recording.storageState !== 'ready' || !recording.contentType) return null;

    const filePath = join(
      this.recordingDirectory(recordingId),
      'source',
      `original.${extensionByContentType[recording.contentType]}`,
    );

    try {
      const file = await stat(filePath);
      return {
        contentType: recording.contentType,
        filePath,
        sizeBytes: file.size,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private recordingDirectory(recordingId: string): string {
    if (!RecordingIdSchema.safeParse(recordingId).success) {
      throw new AppError(400, 'INVALID_REQUEST', 'The recording ID is invalid.');
    }
    return join(this.rootDirectory, 'recordings', recordingId);
  }

  private recordingFile(recordingId: string): string {
    return join(this.recordingDirectory(recordingId), 'recording.json');
  }

  private async writeRecording(recording: Recording): Promise<void> {
    const validated = RecordingSchema.parse(recording);
    const target = this.recordingFile(recording.recordingId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, target);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

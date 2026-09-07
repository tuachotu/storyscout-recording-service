import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AppError } from '../errors.js';
import {
  TranscriptSchema,
  TranscriptionIdSchema,
  TranscriptionJobSchema,
  type Transcript,
  type TranscriptionJob,
} from './types.js';

export class LocalTranscriptionStorage {
  constructor(private readonly rootDirectory: string) {}

  async create(recordingId: string, modelId: string): Promise<TranscriptionJob> {
    const transcriptionId = `transcription_${randomUUID().replaceAll('-', '')}`;
    const now = new Date().toISOString();
    const job: TranscriptionJob = {
      transcriptionId,
      recordingId,
      state: 'queued',
      attempt: 1,
      createdAt: now,
      updatedAt: now,
      modelId,
      detectedLanguages: [],
      statusUrl: `/api/v1/transcriptions/${transcriptionId}`,
      transcriptUrl: null,
      error: null,
    };
    await mkdir(this.directory(transcriptionId), { recursive: true });
    await this.writeJob(job);
    return job;
  }

  async get(transcriptionId: string): Promise<TranscriptionJob | null> {
    if (!TranscriptionIdSchema.safeParse(transcriptionId).success) return null;
    try {
      return TranscriptionJobSchema.parse(
        JSON.parse(await readFile(this.jobFile(transcriptionId), 'utf8')),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async update(job: TranscriptionJob): Promise<void> {
    await this.writeJob({ ...job, updatedAt: new Date().toISOString() });
  }

  async saveTranscript(transcript: Transcript): Promise<void> {
    const validated = TranscriptSchema.parse(transcript);
    await this.atomicWrite(
      this.transcriptJsonFile(transcript.transcriptionId),
      `${JSON.stringify(validated, null, 2)}\n`,
    );
    await this.atomicWrite(this.transcriptTextFile(transcript.transcriptionId), transcript.text);
  }

  async getTranscript(transcriptionId: string): Promise<Transcript | null> {
    if (!TranscriptionIdSchema.safeParse(transcriptionId).success) return null;
    try {
      return TranscriptSchema.parse(
        JSON.parse(await readFile(this.transcriptJsonFile(transcriptionId), 'utf8')),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async recoverable(): Promise<TranscriptionJob[]> {
    const root = join(this.rootDirectory, 'transcriptions');
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    const jobs = await Promise.all(entries.map((entry) => this.get(entry)));
    return jobs.filter(
      (job): job is TranscriptionJob =>
        job !== null && (job.state === 'queued' || job.state === 'processing'),
    );
  }

  directory(transcriptionId: string): string {
    if (!TranscriptionIdSchema.safeParse(transcriptionId).success) {
      throw new AppError(400, 'INVALID_REQUEST', 'The transcription ID is invalid.');
    }
    return join(this.rootDirectory, 'transcriptions', transcriptionId);
  }

  private jobFile(id: string) {
    return join(this.directory(id), 'transcription.json');
  }
  private transcriptJsonFile(id: string) {
    return join(this.directory(id), 'transcript.json');
  }
  private transcriptTextFile(id: string) {
    return join(this.directory(id), 'transcript.txt');
  }

  private async writeJob(job: TranscriptionJob): Promise<void> {
    const validated = TranscriptionJobSchema.parse(job);
    await this.atomicWrite(
      this.jobFile(job.transcriptionId),
      `${JSON.stringify(validated, null, 2)}\n`,
    );
  }

  private async atomicWrite(target: string, contents: string): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents, { flag: 'wx' });
    await rename(temporary, target);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

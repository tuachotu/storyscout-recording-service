import type { AudioStorage } from '../recordings/storage.js';
import { AudioPreparationError, type AudioPreparer } from './preparer.js';
import type { TranscriptionProvider } from './provider.js';
import type { LocalTranscriptionStorage } from './storage.js';
import type { TranscriptionJob } from './types.js';

export class TranscriptionWorker {
  private readonly queue: string[] = [];
  private active = 0;

  constructor(
    private readonly storage: LocalTranscriptionStorage,
    private readonly audioStorage: AudioStorage,
    private readonly provider: TranscriptionProvider,
    private readonly preparer: AudioPreparer,
    private readonly concurrency: number,
  ) {}

  async recover(): Promise<void> {
    for (const job of await this.storage.recoverable()) {
      if (job.state === 'processing') {
        await this.storage.update({ ...job, state: 'queued' });
      }
      this.enqueue(job.transcriptionId);
    }
  }

  enqueue(transcriptionId: string): void {
    if (!this.queue.includes(transcriptionId)) this.queue.push(transcriptionId);
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) return;
      this.active += 1;
      void this.run(id).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }

  private async run(transcriptionId: string): Promise<void> {
    const job = await this.storage.get(transcriptionId);
    if (!job || job.state !== 'queued') return;
    await this.storage.update({ ...job, state: 'processing', error: null });
    let prepared: Awaited<ReturnType<AudioPreparer['prepare']>> | undefined;
    try {
      const audio = await this.audioStorage.openAudio(job.recordingId);
      if (!audio) throw new Error('The source recording audio is unavailable');
      prepared = await this.preparer.prepare(
        audio.filePath,
        this.storage.directory(transcriptionId),
      );
      const results = [];
      for (const file of prepared.files) results.push(await this.provider.transcribe(file));
      const detectedLanguages = [...new Set(results.flatMap((result) => result.detectedLanguages))];
      const transcript = {
        transcriptionId,
        recordingId: job.recordingId,
        text: results
          .map((result) => result.text.trim())
          .filter(Boolean)
          .join('\n\n'),
        detectedLanguages,
        version: 1,
        modelId: job.modelId,
        createdAt: new Date().toISOString(),
      };
      await this.storage.saveTranscript(transcript);
      await this.storage.update({
        ...job,
        state: 'completed',
        detectedLanguages,
        transcriptUrl: `/api/v1/transcriptions/${transcriptionId}/transcript`,
        error: null,
      });
    } catch (error) {
      await this.fail(job, error);
    } finally {
      await prepared?.cleanup().catch(() => undefined);
    }
  }

  private async fail(job: TranscriptionJob, error: unknown): Promise<void> {
    const noKey = error instanceof Error && error.message.includes('OPENAI_API_KEY');
    const preparationFailed = error instanceof AudioPreparationError;
    await this.storage.update({
      ...job,
      state: 'failed',
      error: {
        code: noKey
          ? 'OPENAI_API_KEY_MISSING'
          : preparationFailed
            ? 'AUDIO_PREPARATION_FAILED'
            : 'TRANSCRIPTION_PROVIDER_ERROR',
        message: noKey
          ? 'OpenAI API access is not configured.'
          : preparationFailed
            ? 'The source audio could not be prepared safely for transcription.'
            : 'The transcription provider could not complete the request.',
        retryable: true,
      },
    });
  }
}

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FfmpegAudioPreparer, type MediaCommandRunner } from '../src/transcriptions/preparer.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('production audio preparation', () => {
  it('uses a verified normal small source directly', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'small.wav');
    await writeFile(source, Buffer.alloc(10, 1));
    const commands = new FakeMediaCommands();

    const prepared = await new FfmpegAudioPreparer(100, commands).prepare(source, directory);

    expect(prepared.files).toEqual([source]);
    expect(commands.ffmpegCalls).toHaveLength(1);
    expect(commands.ffmpegCalls[0]).toContain('null');
  });

  it('normalizes a verified large source into ordered validated AAC chunks', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'large.mp3');
    await writeFile(source, Buffer.alloc(200, 1));
    const commands = new FakeMediaCommands({ sourceDuration: 3600, chunkDurations: [1800, 1800] });

    const prepared = await new FfmpegAudioPreparer(100, commands).prepare(source, directory);

    expect(prepared.files.map((path) => path.split('/').at(-1))).toEqual([
      'chunk-0000.m4a',
      'chunk-0001.m4a',
    ]);
    expect(commands.ffmpegCalls.some((args) => args.includes('pcm_s16le'))).toBe(false);
    expect(commands.decodedChunks).toBe(2);
    await prepared.cleanup();
    await expect(access(join(directory, 'prepared-audio'))).rejects.toThrow();
  });

  it('detects malformed stderr, repairs through clean PCM, and validates AAC output', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'malformed.mp3');
    await writeFile(source, Buffer.alloc(20, 1));
    const commands = new FakeMediaCommands({ malformedSource: true });

    const prepared = await new FfmpegAudioPreparer(100, commands).prepare(source, directory);

    expect(commands.ffmpegCalls.some((args) => args.includes('pcm_s16le'))).toBe(true);
    expect(commands.ffmpegCalls.some((args) => args.includes('segment'))).toBe(true);
    expect(commands.decodedChunks).toBe(1);
    await prepared.cleanup();
  });

  it('rejects invalid prepared chunks and cleans every intermediate', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'malformed.mp3');
    await writeFile(source, Buffer.alloc(20, 1));
    const commands = new FakeMediaCommands({ malformedSource: true, malformedChunk: true });

    await expect(new FfmpegAudioPreparer(100, commands).prepare(source, directory)).rejects.toEqual(
      expect.objectContaining({ code: 'AUDIO_PREPARATION_FAILED' }),
    );
    await expect(access(join(directory, 'prepared-audio'))).rejects.toThrow();
  });

  it('rejects duration discontinuity before returning provider files', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'large.mp3');
    await writeFile(source, Buffer.alloc(200, 1));
    const commands = new FakeMediaCommands({ sourceDuration: 60, chunkDurations: [20] });

    await expect(new FfmpegAudioPreparer(100, commands).prepare(source, directory)).rejects.toEqual(
      expect.objectContaining({ code: 'AUDIO_PREPARATION_FAILED' }),
    );
  });
});

interface FakeOptions {
  malformedSource?: boolean;
  malformedChunk?: boolean;
  sourceDuration?: number;
  chunkDurations?: number[];
}

class FakeMediaCommands implements MediaCommandRunner {
  readonly ffmpegCalls: string[][] = [];
  decodedChunks = 0;
  private readonly chunkDurations: number[];

  constructor(private readonly options: FakeOptions = {}) {
    this.chunkDurations = options.chunkDurations ?? [60];
  }

  async run(command: 'ffmpeg' | 'ffprobe', args: string[]) {
    if (command === 'ffprobe') {
      const file = args.at(-1) ?? '';
      const chunkMatch = /chunk-(\d{4})\.m4a$/.exec(file);
      const duration = chunkMatch
        ? this.chunkDurations[Number.parseInt(chunkMatch[1] ?? '0', 10)]
        : (this.options.sourceDuration ?? 60);
      return { stdout: String(duration), stderr: '' };
    }

    this.ffmpegCalls.push(args);
    const output = args.at(-1) ?? '';
    if (args.includes('pcm_s16le')) {
      await writeFile(output, Buffer.alloc(20, 1));
      return { stdout: '', stderr: '' };
    }
    if (args.includes('segment')) {
      for (let index = 0; index < this.chunkDurations.length; index += 1) {
        await writeFile(
          output.replace('%04d', String(index).padStart(4, '0')),
          Buffer.alloc(10, 1),
        );
      }
      return { stdout: '', stderr: '' };
    }
    if (output === '-') {
      const input = args[args.indexOf('-i') + 1] ?? '';
      if (input.endsWith('.m4a')) {
        this.decodedChunks += 1;
        return {
          stdout: '',
          stderr: this.options.malformedChunk ? 'Header missing' : '',
        };
      }
      return {
        stdout: '',
        stderr:
          this.options.malformedSource && !input.endsWith('repaired.wav') ? 'Header missing' : '',
      };
    }
    return { stdout: '', stderr: '' };
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'storyscout-preparer-'));
  directories.push(directory);
  return directory;
}

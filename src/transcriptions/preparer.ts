import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const malformedAudioPatterns = [
  /header missing/i,
  /invalid data found when processing input/i,
  /error submitting packet to decoder/i,
];
const durationToleranceSeconds = 2;

export class AudioPreparationError extends Error {
  readonly code = 'AUDIO_PREPARATION_FAILED';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AudioPreparationError';
  }
}

export interface PreparedAudio {
  files: string[];
  cleanup(): Promise<void>;
}

export interface AudioPreparer {
  prepare(sourcePath: string, workDirectory: string): Promise<PreparedAudio>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface MediaCommandRunner {
  run(command: 'ffmpeg' | 'ffprobe', args: string[]): Promise<CommandResult>;
}

class SystemMediaCommandRunner implements MediaCommandRunner {
  async run(command: 'ffmpeg' | 'ffprobe', args: string[]): Promise<CommandResult> {
    const result = await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

export class FfmpegAudioPreparer implements AudioPreparer {
  constructor(
    private readonly requestLimitBytes: number,
    private readonly commands: MediaCommandRunner = new SystemMediaCommandRunner(),
  ) {}

  async prepare(sourcePath: string, workDirectory: string): Promise<PreparedAudio> {
    const preparationDirectory = join(workDirectory, 'prepared-audio');
    await rm(preparationDirectory, { recursive: true, force: true });
    await mkdir(preparationDirectory, { recursive: true });

    try {
      const source = await stat(sourcePath);
      if (source.size === 0) throw new AudioPreparationError('The source audio is empty');
      let expectedDuration = await this.duration(sourcePath);
      const sourceMalformed = await this.isMalformed(sourcePath);

      if (!sourceMalformed && source.size <= this.requestLimitBytes) {
        await rm(preparationDirectory, { recursive: true, force: true });
        return { files: [sourcePath], cleanup: async () => undefined };
      }

      let inputPath = sourcePath;
      if (sourceMalformed) {
        inputPath = join(preparationDirectory, 'repaired.wav');
        await this.repairToPcm(sourcePath, inputPath);
        if (await this.isMalformed(inputPath)) {
          throw new AudioPreparationError('The repaired PCM audio did not pass decode validation');
        }
        expectedDuration = await this.duration(inputPath);
      }

      const chunksDirectory = join(preparationDirectory, 'chunks');
      await mkdir(chunksDirectory, { recursive: true });
      await this.createChunks(inputPath, chunksDirectory);
      const files = (await readdir(chunksDirectory))
        .filter((file) => /^chunk-\d{4}\.m4a$/.test(file))
        .sort()
        .map((file) => join(chunksDirectory, file));
      if (files.length === 0) {
        throw new AudioPreparationError('ffmpeg did not produce transcription chunks');
      }

      let preparedDuration = 0;
      for (const file of files) {
        const chunk = await stat(file);
        if (chunk.size === 0) throw new AudioPreparationError('A prepared chunk is empty');
        if (chunk.size > this.requestLimitBytes) {
          throw new AudioPreparationError('A prepared chunk exceeds the provider limit');
        }
        if (await this.isMalformed(file)) {
          throw new AudioPreparationError('A prepared chunk did not pass decode validation');
        }
        preparedDuration += await this.duration(file);
      }
      if (Math.abs(preparedDuration - expectedDuration) > durationToleranceSeconds) {
        throw new AudioPreparationError('Prepared chunk duration does not match the source');
      }

      return {
        files,
        cleanup: () => rm(preparationDirectory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(preparationDirectory, { recursive: true, force: true });
      if (error instanceof AudioPreparationError) throw error;
      throw new AudioPreparationError('Audio preparation could not produce verified audio', {
        cause: error,
      });
    }
  }

  private async isMalformed(filePath: string): Promise<boolean> {
    try {
      const result = await this.commands.run('ffmpeg', [
        '-v',
        'error',
        '-i',
        filePath,
        '-map',
        '0:a:0',
        '-f',
        'null',
        '-',
      ]);
      return malformedAudioPatterns.some((pattern) => pattern.test(result.stderr));
    } catch {
      return true;
    }
  }

  private async repairToPcm(sourcePath: string, outputPath: string): Promise<void> {
    await this.commands.run('ffmpeg', [
      '-v',
      'error',
      '-err_detect',
      'ignore_err',
      '-fflags',
      '+discardcorrupt',
      '-i',
      sourcePath,
      '-map',
      '0:a:0',
      '-c:a',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-y',
      outputPath,
    ]);
  }

  private async createChunks(sourcePath: string, chunksDirectory: string): Promise<void> {
    await this.commands.run('ffmpeg', [
      '-v',
      'error',
      '-i',
      sourcePath,
      '-map',
      '0:a:0',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-f',
      'segment',
      '-segment_format',
      'ipod',
      '-segment_time',
      '1800',
      '-reset_timestamps',
      '1',
      join(chunksDirectory, 'chunk-%04d.m4a'),
    ]);
  }

  private async duration(filePath: string): Promise<number> {
    const result = await this.commands.run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const duration = Number.parseFloat(result.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new AudioPreparationError('Audio duration could not be verified');
    }
    return duration;
  }
}

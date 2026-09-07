import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface AudioProbeResult {
  durationSeconds: number;
}

export interface AudioProbe {
  probe(filePath: string): Promise<AudioProbeResult>;
}

export class FfprobeAudioProbe implements AudioProbe {
  async probe(filePath: string): Promise<AudioProbeResult> {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath],
      { maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
    const durationSeconds = Number(parsed.format?.duration);

    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new Error('ffprobe did not return a valid audio duration');
    }

    return { durationSeconds };
  }
}

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EPUBContainer } from '../types.js';

/**
 * Offset information for a source audio file in the concatenated output
 */
export interface AudioOffset {
  originalPath: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

/**
 * Result of audio concatenation
 */
export interface ConcatResult {
  /** Path to the concatenated audio file */
  outputPath: string;
  /** Mapping from original audio path to offset in concatenated file */
  offsets: Map<string, AudioOffset>;
  /** Total duration in milliseconds */
  totalDurationMs: number;
}

/**
 * Get the duration of an audio file in milliseconds using ffprobe
 */
async function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);

    let stdout = '';
    let stderr = '';

    ffprobe.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr}`));
        return;
      }
      const seconds = parseFloat(stdout.trim());
      if (Number.isNaN(seconds)) {
        reject(new Error(`Could not parse duration from ffprobe output: ${stdout}`));
        return;
      }
      resolve(seconds * 1000);
    });
  });
}

/**
 * Run FFmpeg to concatenate and transcode audio files
 */
async function runFFmpeg(concatFilePath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Use OGG Opus with good quality settings for audiobooks
    // -b:a 48k is good for voice, -vbr on enables variable bitrate
    const ffmpeg = spawn('ffmpeg', [
      '-y', // Overwrite output
      '-f',
      'concat', // Use concat demuxer
      '-safe',
      '0', // Allow absolute paths
      '-i',
      concatFilePath, // Input concat file
      '-c:a',
      'libopus', // Opus codec
      '-b:a',
      '48k', // 48kbps bitrate (good for speech)
      '-vbr',
      'on', // Variable bitrate
      '-application',
      'voip', // Optimize for speech
      outputPath,
    ]);

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Concatenate audio files from an EPUB into a single OGG Opus file.
 *
 * @param audioFiles - List of audio file paths (relative to EPUB root)
 * @param container - EPUB container for reading files
 * @param outputPath - Path where the concatenated file should be written
 * @returns Offset mapping and total duration
 */
export async function concatenateAudio(
  audioFiles: string[],
  container: EPUBContainer,
  outputPath: string,
): Promise<ConcatResult> {
  if (audioFiles.length === 0) {
    return {
      outputPath,
      offsets: new Map(),
      totalDurationMs: 0,
    };
  }

  // Create a temporary directory for extracted audio files
  const tempDir = await mkdtemp(join(tmpdir(), 'cadence-audio-'));

  try {
    const offsets = new Map<string, AudioOffset>();
    const tempFiles: string[] = [];
    let currentOffsetMs = 0;

    console.log(`  Extracting ${audioFiles.length} audio files...`);

    // Extract each audio file to a temp path
    for (const audioPath of audioFiles) {
      const audioData = await container.readFile(audioPath);
      const tempPath = join(tempDir, audioPath.replace(/\//g, '_'));
      await writeFile(tempPath, audioData);
      tempFiles.push(tempPath);
    }

    // Probe durations in parallel
    const durationsMs = await Promise.all(tempFiles.map((filePath) => getAudioDuration(filePath)));

    for (let i = 0; i < audioFiles.length; i++) {
      const audioPath = audioFiles[i]!;
      const durationMs = durationsMs[i]!;

      offsets.set(audioPath, {
        originalPath: audioPath,
        startMs: currentOffsetMs,
        endMs: currentOffsetMs + durationMs,
        durationMs,
      });

      currentOffsetMs += durationMs;
    }

    console.log(`  Total audio duration: ${(currentOffsetMs / 1000 / 60).toFixed(1)} minutes`);
    console.log(`  Concatenating to OGG Opus...`);

    // Create FFmpeg concat file
    const concatFileContent = tempFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    const concatFilePath = join(tempDir, 'concat.txt');
    await writeFile(concatFilePath, concatFileContent);

    // Run FFmpeg
    await runFFmpeg(concatFilePath, outputPath);

    console.log(`  Audio concatenation complete`);

    return {
      outputPath,
      offsets,
      totalDurationMs: currentOffsetMs,
    };
  } finally {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Update span timestamps based on audio offset mapping.
 * Modifies spans in place.
 */
export function applyAudioOffsets<
  T extends { audioSrc: string; clipBeginMs: number; clipEndMs: number },
>(spans: T[], offsets: Map<string, AudioOffset>): void {
  for (const span of spans) {
    if (span.clipBeginMs < 0 || span.clipEndMs < 0) {
      continue;
    }
    const offset = offsets.get(span.audioSrc);
    if (offset) {
      span.clipBeginMs += offset.startMs;
      span.clipEndMs += offset.startMs;
    } else {
      console.warn(`Warning: No offset found for audio file: ${span.audioSrc}`);
    }
  }
}

/**
 * Concatenate audio files from disk into a single OGG Opus file.
 * Unlike concatenateAudio, this works with direct file paths rather than an EPUBContainer.
 *
 * @param audioFiles - List of absolute paths to audio files
 * @param outputPath - Path where the concatenated file should be written
 * @returns Offset mapping and total duration
 */
export async function concatenateAudioFiles(
  audioFiles: string[],
  outputPath: string,
): Promise<ConcatResult> {
  if (audioFiles.length === 0) {
    return {
      outputPath,
      offsets: new Map(),
      totalDurationMs: 0,
    };
  }

  // Create a temporary directory for the concat file
  const tempDir = await mkdtemp(join(tmpdir(), 'cadence-audio-'));

  try {
    const offsets = new Map<string, AudioOffset>();
    let currentOffsetMs = 0;

    console.log(`  Processing ${audioFiles.length} audio files...`);

    // Get durations for each audio file in parallel
    const durationsMs = await Promise.all(
      audioFiles.map((audioPath) => getAudioDuration(audioPath)),
    );

    for (let i = 0; i < audioFiles.length; i++) {
      const audioPath = audioFiles[i]!;
      const durationMs = durationsMs[i]!;

      offsets.set(audioPath, {
        originalPath: audioPath,
        startMs: currentOffsetMs,
        endMs: currentOffsetMs + durationMs,
        durationMs,
      });

      currentOffsetMs += durationMs;
    }

    console.log(`  Total audio duration: ${(currentOffsetMs / 1000 / 60).toFixed(1)} minutes`);
    console.log(`  Concatenating to OGG Opus...`);

    // Create FFmpeg concat file
    const concatFileContent = audioFiles
      .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
      .join('\n');
    const concatFilePath = join(tempDir, 'concat.txt');
    await writeFile(concatFilePath, concatFileContent);

    // Run FFmpeg
    await runFFmpeg(concatFilePath, outputPath);

    console.log(`  Audio concatenation complete`);

    return {
      outputPath,
      offsets,
      totalDurationMs: currentOffsetMs,
    };
  } finally {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
  }
}

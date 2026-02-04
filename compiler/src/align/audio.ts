/**
 * Audio utilities for the alignment module.
 *
 * MIT License
 * Copyright (c) 2026 Ryan Johnson
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

// Supported audio formats
export const AUDIO_EXTENSIONS = [
  '.mp3',
  '.m4a',
  '.m4b',
  '.mp4',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.flac',
  '.webm',
];

export interface ChapterInfo {
  id: number;
  title: string;
  startTime: number;
  endTime: number;
}

export interface AudioTrack {
  path: string;
  duration: number;
  title?: string;
}

/**
 * Check if a file is a supported audio format.
 */
export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.includes(extname(filePath).toLowerCase());
}

// Cache for track durations to avoid repeated ffprobe calls
const durationCache = new Map<string, number>();

/**
 * Get the duration of an audio file in seconds using ffprobe.
 * Results are cached to avoid repeated subprocess spawns.
 */
export async function getTrackDuration(filePath: string): Promise<number> {
  const cached = durationCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  const duration = await getTrackDurationUncached(filePath);
  durationCache.set(filePath, duration);
  return duration;
}

/**
 * Get the duration of an audio file in seconds using ffprobe (uncached).
 */
async function getTrackDurationUncached(filePath: string): Promise<number> {
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

      const duration = parseFloat(stdout.trim());
      if (Number.isNaN(duration)) {
        reject(new Error(`Could not parse duration from ffprobe output: ${stdout}`));
        return;
      }

      resolve(duration);
    });
  });
}

/**
 * Get chapter information from an audio file (e.g., m4b).
 * Returns empty array if no chapters found.
 */
export async function getChapters(filePath: string): Promise<ChapterInfo[]> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_chapters', '-of', 'json', filePath]);

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

      try {
        const result = JSON.parse(stdout) as {
          chapters: Array<{
            id: number;
            start_time: string;
            end_time: string;
            tags?: { title?: string };
          }>;
        };

        const chapters: ChapterInfo[] = result.chapters.map((ch, index) => ({
          id: ch.id ?? index,
          title: ch.tags?.title ?? `Chapter ${index + 1}`,
          startTime: parseFloat(ch.start_time),
          endTime: parseFloat(ch.end_time),
        }));

        resolve(chapters);
      } catch (e) {
        reject(new Error(`Failed to parse chapter info: ${e}`));
      }
    });
  });
}

/**
 * Split an audio file by time range.
 * Uses stream copy (no re-encoding) for speed when possible.
 */
export async function splitTrack(
  inputPath: string,
  startTime: number,
  endTime: number,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-nostdin',
      '-y', // Overwrite output
      '-ss',
      startTime.toString(),
      '-to',
      endTime.toString(),
      '-i',
      inputPath,
      '-c',
      'copy', // Stream copy (fast, no re-encoding)
      '-map',
      '0:a', // Audio only
      outputPath,
    ]);

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg split failed: ${stderr}`));
        return;
      }
      resolve();
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
}

/**
 * Extract chapters from a single audio file into separate files.
 *
 * @param inputPath Path to audio file with chapters (e.g., .m4b)
 * @param outputDir Directory to write chapter files
 * @returns Array of paths to extracted chapter files
 */
export async function extractChapters(inputPath: string, outputDir: string): Promise<AudioTrack[]> {
  const chapters = await getChapters(inputPath);

  if (chapters.length === 0) {
    // No chapters - return the original file as a single track
    const duration = await getTrackDuration(inputPath);
    return [
      {
        path: inputPath,
        duration,
      },
    ];
  }

  await mkdir(outputDir, { recursive: true });

  const ext = extname(inputPath);
  const tracks: AudioTrack[] = [];

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    const paddedIndex = String(i + 1).padStart(3, '0');
    const outputPath = join(outputDir, `chapter_${paddedIndex}${ext}`);

    await splitTrack(inputPath, chapter.startTime, chapter.endTime, outputPath);

    tracks.push({
      path: outputPath,
      duration: chapter.endTime - chapter.startTime,
      title: chapter.title,
    });
  }

  return tracks;
}

/**
 * Get audio tracks from a directory of audio files.
 * Files are sorted alphabetically.
 */
export async function getTracksFromDirectory(dirPath: string): Promise<AudioTrack[]> {
  const entries = await readdir(dirPath);
  const audioFiles = entries.filter((f) => isAudioFile(f)).sort(); // Alphabetical order

  const tracks: AudioTrack[] = [];

  for (const file of audioFiles) {
    const filePath = join(dirPath, file);
    const duration = await getTrackDuration(filePath);
    tracks.push({
      path: filePath,
      duration,
      title: basename(file, extname(file)),
    });
  }

  return tracks;
}

/**
 * Prepare audio for transcription.
 *
 * Handles:
 * - Single file with chapters (m4b) -> extracts to temp dir
 * - Single file without chapters -> returns as-is
 * - Directory of audio files -> returns sorted list
 *
 * @param inputPath Path to audio file or directory
 * @param tempDir Directory for extracted chapters (if needed)
 * @returns Array of audio tracks ready for transcription
 */
export async function prepareAudioTracks(
  inputPath: string,
  tempDir: string,
): Promise<AudioTrack[]> {
  const stats = await stat(inputPath);

  if (stats.isDirectory()) {
    return getTracksFromDirectory(inputPath);
  }

  // Single file - check for chapters
  const chapters = await getChapters(inputPath);

  if (chapters.length > 0) {
    console.log(`Found ${chapters.length} chapters in ${basename(inputPath)}`);
    return extractChapters(inputPath, tempDir);
  }

  // No chapters - return as single track
  const duration = await getTrackDuration(inputPath);
  return [
    {
      path: inputPath,
      duration,
    },
  ];
}

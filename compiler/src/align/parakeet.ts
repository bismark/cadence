/**
 * Parakeet-mlx transcription adapter.
 * Calls parakeet-mlx CLI and converts output to our Transcription format.
 *
 * MIT License
 * Copyright (c) 2026 Ryan Johnson
 */

import { spawn } from 'node:child_process';
import type { Transcription, WordTimelineEntry } from './getSentenceRanges.js';

/**
 * Parakeet-mlx JSON output structure
 */
interface ParakeetToken {
  text: string;
  start: number;
  end: number;
  duration: number;
}

interface ParakeetSentence {
  text: string;
  start: number;
  end: number;
  duration: number;
  tokens: ParakeetToken[];
}

interface ParakeetResult {
  text: string;
  sentences: ParakeetSentence[];
}

/**
 * Transcribe an audio file using parakeet-mlx.
 *
 * @param audioPath Path to the audio file
 * @param options Optional configuration
 * @returns Transcription with word-level timestamps
 */
export async function transcribe(
  audioPath: string,
  options: {
    /** Custom path to parakeet-mlx CLI (default: 'parakeet-mlx') */
    parakeetPath?: string;
    /** Chunk duration in seconds for long audio (default: 120) */
    chunkDuration?: number;
    /** Overlap between chunks in seconds (default: 15) */
    overlapDuration?: number;
  } = {},
): Promise<Transcription> {
  const { parakeetPath = 'parakeet-mlx', chunkDuration = 120, overlapDuration = 15 } = options;

  const args = [
    audioPath,
    '--output-format',
    'json',
    '--highlight-words',
    '--chunk-duration',
    chunkDuration.toString(),
    '--overlap-duration',
    overlapDuration.toString(),
  ];

  const result = await runParakeet(parakeetPath, audioPath, args);
  return convertToTranscription(result, audioPath);
}

/**
 * Run parakeet-mlx CLI and parse JSON output from file.
 * parakeet-mlx writes output to files, not stdout.
 */
async function runParakeet(
  cmd: string,
  audioPath: string,
  baseArgs: string[],
): Promise<ParakeetResult> {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, parse } = await import('node:path');

  // Create temp directory for output
  const tempDir = await mkdtemp(join(tmpdir(), 'parakeet-'));

  try {
    const args = [...baseArgs, '--output-dir', tempDir];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(cmd, args, {
        stdio: ['ignore', 'inherit', 'inherit'], // Show progress on terminal
        env: {
          ...process.env,
          HF_HUB_OFFLINE: '1', // Prevent network requests to Hugging Face
        },
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`parakeet-mlx failed with exit code ${code}`));
          return;
        }
        resolve();
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn parakeet-mlx: ${err.message}`));
      });
    });

    // Read the output JSON file
    // parakeet-mlx names output as {filename}.json
    const audioBasename = parse(audioPath).name;
    const jsonPath = join(tempDir, `${audioBasename}.json`);

    const jsonContent = await readFile(jsonPath, 'utf-8');
    return JSON.parse(jsonContent) as ParakeetResult;
  } finally {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Convert parakeet-mlx output to our Transcription format.
 *
 * Key task: compute character offsets for each word in the full transcript.
 */
function convertToTranscription(result: ParakeetResult, audiofile: string): Transcription {
  const transcript = result.text;
  const wordTimeline: WordTimelineEntry[] = [];

  // Track our position in the transcript as we match tokens
  let searchStart = 0;

  for (const sentence of result.sentences) {
    for (const token of sentence.tokens) {
      // Find this token in the transcript
      // Note: token.text might not include punctuation that's in the transcript
      const tokenText = token.text.trim();
      if (!tokenText) continue;

      // Search for the token starting from where we left off
      const index = transcript.indexOf(tokenText, searchStart);

      if (index === -1) {
        // Token not found - might be a normalization issue
        // Try case-insensitive search
        const lowerTranscript = transcript.toLowerCase();
        const lowerToken = tokenText.toLowerCase();
        const altIndex = lowerTranscript.indexOf(lowerToken, searchStart);

        if (altIndex !== -1) {
          wordTimeline.push({
            text: tokenText,
            startTime: token.start,
            endTime: token.end,
            startOffsetUtf16: altIndex,
            endOffsetUtf16: altIndex + tokenText.length,
            audiofile,
          });
          searchStart = altIndex + tokenText.length;
        }
        // If still not found, skip this token
        continue;
      }

      wordTimeline.push({
        text: tokenText,
        startTime: token.start,
        endTime: token.end,
        startOffsetUtf16: index,
        endOffsetUtf16: index + tokenText.length,
        audiofile,
      });

      // Move search position forward
      searchStart = index + tokenText.length;
    }
  }

  return {
    transcript,
    wordTimeline,
  };
}

/**
 * Transcribe multiple audio files and concatenate results.
 * Useful for audiobooks with multiple chapter files.
 *
 * @param audioPaths Array of audio file paths in order
 * @param options Optional configuration
 * @returns Combined transcription with word-level timestamps
 */
export async function transcribeMultiple(
  audioPaths: string[],
  options: Parameters<typeof transcribe>[1] = {},
): Promise<Transcription> {
  if (audioPaths.length === 0) {
    return { transcript: '', wordTimeline: [] };
  }

  if (audioPaths.length === 1) {
    return transcribe(audioPaths[0], options);
  }

  // Transcribe each file
  const transcriptions = await Promise.all(audioPaths.map((path) => transcribe(path, options)));

  // Concatenate transcriptions
  let combinedTranscript = '';
  const combinedTimeline: WordTimelineEntry[] = [];

  for (const transcription of transcriptions) {
    // Add space between transcriptions if needed
    if (combinedTranscript.length > 0 && !combinedTranscript.endsWith(' ')) {
      combinedTranscript += ' ';
    }

    // Capture offset AFTER space is added
    const offset = combinedTranscript.length;

    // Adjust offsets for this transcription's words
    for (const entry of transcription.wordTimeline) {
      combinedTimeline.push({
        ...entry,
        startOffsetUtf16: entry.startOffsetUtf16! + offset,
        endOffsetUtf16: entry.endOffsetUtf16! + offset,
      });
    }

    combinedTranscript += transcription.transcript;
  }

  return {
    transcript: combinedTranscript,
    wordTimeline: combinedTimeline,
  };
}

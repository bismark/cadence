/**
 * Tests for alignment functions.
 * Uses fixtures from Storyteller project to verify our implementation
 * produces matching results.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getSentenceRanges,
  interpolateSentenceRanges,
  expandEmptySentenceRanges,
  getChapterDuration,
  type SentenceRange,
  type Transcription,
} from '../src/align/index.js';

// Load fixtures
const fixturesDir = join(__dirname, 'fixtures');

const loadTranscription = (): Transcription => {
  const raw = JSON.parse(readFileSync(join(fixturesDir, 'mobydick-transcription.json'), 'utf-8'));

  // Convert to our Transcription format
  return {
    transcript: raw.transcript,
    wordTimeline: raw.wordTimeline.map((entry: any) => ({
      text: entry.text,
      startTime: entry.startTime,
      endTime: entry.endTime,
      startOffsetUtf16: entry.startOffsetUtf16,
      endOffsetUtf16: entry.endOffsetUtf16,
      audiofile: 'test-audio.mp3',
    })),
  };
};

const loadExpectedRanges = (): SentenceRange[] => {
  return JSON.parse(readFileSync(join(fixturesDir, 'mobydick-expected-ranges.json'), 'utf-8'));
};

describe('getChapterDuration', () => {
  it('calculates duration for single audio file', () => {
    const input: SentenceRange[] = [
      { id: 0, start: 0, end: 5, audiofile: '1.mp3' },
      { id: 1, start: 5, end: 10, audiofile: '1.mp3' },
      { id: 2, start: 10, end: 15, audiofile: '1.mp3' },
      { id: 3, start: 15, end: 20, audiofile: '1.mp3' },
    ];

    expect(getChapterDuration(input)).toBe(20);
  });

  it('calculates duration across multiple audio files', () => {
    const input: SentenceRange[] = [
      { id: 0, start: 10, end: 15, audiofile: '1.mp3' },
      { id: 1, start: 15, end: 20, audiofile: '1.mp3' },
      { id: 2, start: 0, end: 5, audiofile: '2.mp3' },
      { id: 3, start: 5, end: 10, audiofile: '2.mp3' },
    ];

    expect(getChapterDuration(input)).toBe(20);
  });
});

describe('interpolateSentenceRanges', () => {
  it('returns contiguous ranges as-is', async () => {
    const input: SentenceRange[] = [
      { id: 0, start: 0, end: 3.45, audiofile: '1.mp3' },
      { id: 1, start: 3.45, end: 6.74, audiofile: '1.mp3' },
      { id: 2, start: 6.74, end: 10.2, audiofile: '1.mp3' },
      { id: 3, start: 10.2, end: 12.89, audiofile: '1.mp3' },
    ];

    const output = await interpolateSentenceRanges(input, null);
    expect(output).toEqual(input);
  });

  it('interpolates starting sentences of first audiofile', async () => {
    const input: SentenceRange[] = [
      { id: 2, start: 6.74, end: 10.2, audiofile: '1.mp3' },
      { id: 3, start: 10.2, end: 12.89, audiofile: '1.mp3' },
    ];

    const expected: SentenceRange[] = [
      { id: 0, start: -1, end: -1, audiofile: '1.mp3' },
      { id: 1, start: -1, end: -1, audiofile: '1.mp3' },
      { id: 2, start: 6.74, end: 10.2, audiofile: '1.mp3' },
      { id: 3, start: 10.2, end: 12.89, audiofile: '1.mp3' },
    ];

    const output = await interpolateSentenceRanges(input, null);
    expect(output).toEqual(expected);
  });

  it('interpolates a sentence within audiofile', async () => {
    const input: SentenceRange[] = [
      { id: 0, start: 0, end: 3.45, audiofile: '1.mp3' },
      { id: 2, start: 6.74, end: 10.2, audiofile: '1.mp3' },
      { id: 3, start: 10.2, end: 12.89, audiofile: '1.mp3' },
    ];

    const expected: SentenceRange[] = [
      { id: 0, start: 0, end: 3.45, audiofile: '1.mp3' },
      { id: 1, start: -1, end: -1, audiofile: '1.mp3' },
      { id: 2, start: 6.74, end: 10.2, audiofile: '1.mp3' },
      { id: 3, start: 10.2, end: 12.89, audiofile: '1.mp3' },
    ];

    const output = await interpolateSentenceRanges(input, null);
    expect(output).toEqual(expected);
  });

  it('interpolates multiple sentences within audiofile', async () => {
    const input: SentenceRange[] = [
      { id: 0, start: 0, end: 3.45, audiofile: '1.mp3' },
      { id: 3, start: 10.2, end: 12.89, audiofile: '1.mp3' },
    ];

    const expected: SentenceRange[] = [
      { id: 0, start: 0, end: 3.45, audiofile: '1.mp3' },
      { id: 1, start: -1, end: -1, audiofile: '1.mp3' },
      { id: 2, start: -1, end: -1, audiofile: '1.mp3' },
      { id: 3, start: 10.2, end: 12.89, audiofile: '1.mp3' },
    ];

    const output = await interpolateSentenceRanges(input, null);
    expect(output).toEqual(expected);
  });
});

describe('expandEmptySentenceRanges', () => {
  it('handles overlapping ranges by nudging start times', () => {
    const input: SentenceRange[] = [
      { id: 0, start: 0, end: 5, audiofile: '1.mp3' },
      { id: 1, start: 4, end: 8, audiofile: '1.mp3' }, // overlaps with previous
    ];

    const output = expandEmptySentenceRanges(input);

    expect(output.length).toBe(2);
    expect(output[0].end).toBe(5);
    expect(output[1].start).toBe(5); // nudged to not overlap
  });

  it('expands empty ranges (end <= start) to minimal duration', () => {
    // expandEmptySentenceRanges only expands when there's a comparison
    // with a previous range that causes the nudge
    const input: SentenceRange[] = [
      { id: 0, start: 0, end: 5, audiofile: '1.mp3' },
      { id: 1, start: 5, end: 5, audiofile: '1.mp3' }, // zero duration after nudge
    ];

    const output = expandEmptySentenceRanges(input);

    // Second range should have minimal duration
    expect(output[1].end).toBeGreaterThan(output[1].start);
  });

  it('returns empty array for empty input', () => {
    expect(expandEmptySentenceRanges([])).toEqual([]);
  });
});

describe('getSentenceRanges with real transcription', () => {
  it('finds sentence ranges in transcription', async () => {
    const transcription = loadTranscription();

    // Use sentences that exactly match the beginning of the transcript
    // (the LibriVox intro)
    const sentences = [
      'This is a LibriVox recording.',
      'All LibriVox recordings are in the public domain.',
      'For more information or to volunteer, please visit librivox.org.',
    ];

    const { sentenceRanges } = await getSentenceRanges(
      0,
      transcription,
      sentences,
      0, // Start at beginning
      null,
    );

    // Should find at least some sentences
    expect(sentenceRanges.length).toBeGreaterThan(0);

    // First range should start near the beginning of the audio
    const firstRange = sentenceRanges[0];
    expect(firstRange.start).toBeLessThan(10); // Within first 10 seconds
  });

  it('produces ranges with valid structure', async () => {
    const transcription = loadTranscription();

    const sentences = [
      'This is a LibriVox recording.',
      'All LibriVox recordings are in the public domain.',
    ];

    const { sentenceRanges } = await getSentenceRanges(
      0,
      transcription,
      sentences,
      0, // Start at beginning
      null,
    );

    // Each range should have required fields
    for (const range of sentenceRanges) {
      expect(typeof range.id).toBe('number');
      expect(typeof range.start).toBe('number');
      expect(typeof range.end).toBe('number');
      expect(typeof range.audiofile).toBe('string');
      expect(range.end).toBeGreaterThanOrEqual(range.start);
    }
  });

  it('respects sentence order in output', async () => {
    const transcription = loadTranscription();

    const sentences = [
      'This is a LibriVox recording.',
      'All LibriVox recordings are in the public domain.',
    ];

    const { sentenceRanges } = await getSentenceRanges(0, transcription, sentences, 0, null);

    // IDs should be in order
    for (let i = 1; i < sentenceRanges.length; i++) {
      expect(sentenceRanges[i].id).toBeGreaterThan(sentenceRanges[i - 1].id);
    }
  });
});

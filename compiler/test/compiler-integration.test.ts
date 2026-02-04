/**
 * Integration test for the compiler using Moby Dick fixtures.
 *
 * Tests the full pipeline: EPUB → sentences → alignment → bundle structure
 * (mocks transcription to avoid needing parakeet-mlx)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { openEPUB } from '../src/epub/container.js';
import { parseOPF, getSpineXHTMLFiles } from '../src/epub/opf.js';
import {
  extractSentences,
  tagSentencesInXhtml,
  getSentenceRanges,
  interpolateSentenceRanges,
  expandEmptySentenceRanges,
  type Transcription,
} from '../src/align/index.js';

const fixturesDir = join(__dirname, 'fixtures');

const loadTranscription = (): Transcription => {
  const raw = JSON.parse(readFileSync(join(fixturesDir, 'mobydick-transcription.json'), 'utf-8'));

  return {
    transcript: raw.transcript,
    wordTimeline: raw.wordTimeline.map((entry: any) => ({
      text: entry.text,
      startTime: entry.startTime,
      endTime: entry.endTime,
      startOffsetUtf16: entry.startOffsetUtf16,
      endOffsetUtf16: entry.endOffsetUtf16,
      audiofile: 'moby-dick-ch1-2.mp3',
    })),
  };
};

describe('Compiler Integration - Moby Dick', () => {
  it('opens and parses the EPUB correctly', async () => {
    const epubPath = join(fixturesDir, 'moby-dick.epub');
    const container = await openEPUB(epubPath);

    try {
      const opf = await parseOPF(container);

      expect(opf.title).toContain('Moby');

      const spineFiles = getSpineXHTMLFiles(opf);
      expect(spineFiles.length).toBeGreaterThan(0);
    } finally {
      await container.close();
    }
  });

  it('extracts sentences from XHTML chapters', async () => {
    const epubPath = join(fixturesDir, 'moby-dick.epub');
    const container = await openEPUB(epubPath);

    try {
      const opf = await parseOPF(container);
      const spineFiles = getSpineXHTMLFiles(opf);

      // Get first chapter content
      const firstChapter = spineFiles[1]; // Skip title page
      const content = await container.readFile(firstChapter.href);
      const xhtml = content.toString('utf-8');

      const sentences = extractSentences(xhtml);

      expect(sentences.length).toBeGreaterThan(10);
      // Moby Dick starts with "Call me Ishmael"
      const hasIshmael = sentences.some((s) => s.includes('Ishmael'));
      expect(hasIshmael).toBe(true);
    } finally {
      await container.close();
    }
  });

  it('tags sentences in XHTML with span IDs', async () => {
    const epubPath = join(fixturesDir, 'moby-dick.epub');
    const container = await openEPUB(epubPath);

    try {
      const opf = await parseOPF(container);
      const spineFiles = getSpineXHTMLFiles(opf);

      const firstChapter = spineFiles[1];
      const content = await container.readFile(firstChapter.href);
      const xhtml = content.toString('utf-8');

      const { html: taggedHtml, sentences } = tagSentencesInXhtml(xhtml, 'chapter1');

      expect(sentences.length).toBeGreaterThan(0);
      expect(taggedHtml).toContain('id="chapter1-sentence0"');
      expect(taggedHtml).toContain('id="chapter1-sentence1"');
    } finally {
      await container.close();
    }
  });

  it('aligns sentences with transcription', async () => {
    const epubPath = join(fixturesDir, 'moby-dick.epub');
    const container = await openEPUB(epubPath);
    const transcription = loadTranscription();

    try {
      const opf = await parseOPF(container);
      const spineFiles = getSpineXHTMLFiles(opf);

      // Get chapter 1 content
      const chapter = spineFiles[1];
      const content = await container.readFile(chapter.href);
      const xhtml = content.toString('utf-8');

      const allSentences = extractSentences(xhtml);

      // Find where "Call me Ishmael" starts in the sentences
      // (skip Project Gutenberg header)
      const ishmaelIndex = allSentences.findIndex((s) => s.includes('Call me Ishmael'));
      expect(ishmaelIndex).toBeGreaterThan(0);

      // Use sentences starting from "Call me Ishmael"
      const sentences = allSentences.slice(ishmaelIndex, ishmaelIndex + 20);

      // Find offset where chapter content starts in transcription
      const chapterStart = transcription.transcript.indexOf('Call me Ishmael');
      expect(chapterStart).toBeGreaterThan(0);

      // Get sentence ranges
      const { sentenceRanges } = await getSentenceRanges(
        0,
        transcription,
        sentences,
        chapterStart,
        null,
      );

      expect(sentenceRanges.length).toBeGreaterThan(0);

      // Interpolate and expand
      const interpolated = await interpolateSentenceRanges(sentenceRanges, null);
      const expanded = expandEmptySentenceRanges(interpolated);

      // Verify timing makes sense - ranges should have valid structure
      // Note: sentenceId=0 forces start=0 (intentional for chapter starts)
      for (const range of expanded) {
        expect(range.start).toBeGreaterThanOrEqual(0);
        expect(range.end).toBeGreaterThan(range.start);
        expect(range.audiofile).toBe('moby-dick-ch1-2.mp3');
      }

      // Ranges should be in ascending order
      for (let i = 1; i < expanded.length; i++) {
        expect(expanded[i].start).toBeGreaterThanOrEqual(expanded[i - 1].end - 0.01);
      }

      // Total duration should be reasonable (not 0, not hours)
      const totalDuration = expanded[expanded.length - 1].end - expanded[0].start;
      expect(totalDuration).toBeGreaterThan(10); // At least 10 seconds
      expect(totalDuration).toBeLessThan(300); // Less than 5 minutes
    } finally {
      await container.close();
    }
  });

  it('produces valid span structure for bundle', async () => {
    const epubPath = join(fixturesDir, 'moby-dick.epub');
    const container = await openEPUB(epubPath);
    const transcription = loadTranscription();

    try {
      const opf = await parseOPF(container);
      const spineFiles = getSpineXHTMLFiles(opf);

      const chapter = spineFiles[1];
      const content = await container.readFile(chapter.href);
      const xhtml = content.toString('utf-8');

      // Tag sentences
      const { html: taggedHtml, sentences: allSentences } = tagSentencesInXhtml(xhtml, chapter.id);

      // Find where "Call me Ishmael" starts (skip Project Gutenberg header)
      const ishmaelIndex = allSentences.findIndex((s) => s.includes('Call me Ishmael'));
      const sentences = allSentences.slice(ishmaelIndex, ishmaelIndex + 10);

      // Align with audio - use startSentence=0 for the sliced sentences
      const chapterStart = transcription.transcript.indexOf('Call me Ishmael');
      const { sentenceRanges } = await getSentenceRanges(
        0, // Start from 0 since we sliced the sentences array
        transcription,
        sentences,
        chapterStart,
        null,
      );

      const interpolated = await interpolateSentenceRanges(sentenceRanges, null);
      const expanded = expandEmptySentenceRanges(interpolated);

      // Create span objects like the compiler would
      // Map range.id back to the original sentence index
      const spans = expanded.map((range) => ({
        id: `${chapter.id}-sentence${ishmaelIndex + range.id}`,
        chapterId: chapter.id,
        textRef: `${chapter.href}#${chapter.id}-sentence${ishmaelIndex + range.id}`,
        audioSrc: range.audiofile,
        clipBeginMs: Math.round(range.start * 1000),
        clipEndMs: Math.round(range.end * 1000),
      }));

      // Verify span structure
      expect(spans.length).toBeGreaterThan(0);
      for (const span of spans) {
        expect(span.id).toMatch(/^.+-sentence\d+$/);
        expect(span.clipEndMs).toBeGreaterThan(span.clipBeginMs);
      }
    } finally {
      await container.close();
    }
  });
});

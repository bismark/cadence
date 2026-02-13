#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import {
  expandEmptySentenceRanges,
  extractSentences,
  findNearestMatch,
  getSentenceRanges,
  interpolateSentenceRanges,
  prepareAudioTracks,
  type SentenceRange,
  type Transcription,
  tagSentencesInXhtml,
  transcribeMultiple,
} from './align/index.js';
import {
  getAudioFileName,
  parseAudioOutputFormat,
  type AudioOutputFormat,
} from './audio/concat.js';
import { compactPageStyles } from './bundle/compact-page-styles.js';
import { compactSpanIds } from './bundle/compact-span-ids.js';
import { writeBundle, writeBundleUncompressed } from './bundle/writer.js';
import { getProfile, profiles } from './device-profiles/profiles.js';
import { openEPUB } from './epub/container.js';
import {
  getAudioFilesInFirstSpanUseOrder,
  getSpineXHTMLFiles,
  parseOPF,
} from './epub/opf.js';
import { parseChapterSMIL } from './epub/smil.js';
import { buildTocEntries } from './epub/toc.js';
import { normalizeXHTML } from './epub/xhtml.js';
import {
  assignSpansToPages,
  closeBrowser,
  initBrowser,
  paginateChapters,
} from './layout/paginate.js';
import { splitSpansAcrossPages } from './layout/split-spans-across-pages.js';
import { loadBundle, previewAtTimestamp } from './preview.js';
import type {
  BundleMeta,
  DeviceProfile,
  EPUBContainer,
  NormalizedContent,
  Page,
  Span,
  TocEntry,
} from './types.js';
import {
  logSmilToDomValidationResult,
  validateSmilToDomTargets,
} from './validation/smil-targets.js';
import {
  logUnsupportedFeatureScanResult,
  scanUnsupportedFeatures,
} from './validation/unsupported-features.js';
import { logValidationResult, validateCompilationResult } from './validation.js';

const program = new Command();

program
  .name('cadence-compile')
  .description('Compile EPUB3 Media Overlays into Cadence bundles')
  .version('0.1.0');

program
  .command('compile')
  .description('Compile an EPUB with media overlays into a Cadence bundle')
  .requiredOption('-i, --input <path>', 'Input EPUB file path')
  .option('-o, --output <path>', 'Output bundle path (default: <input>.bundle.zip)')
  .option('-p, --profile <name>', `Device profile (${Object.keys(profiles).join(', ')})`)
  .option('--no-zip', 'Output uncompressed bundle directory instead of ZIP')
  .option('--audio-format <format>', 'Bundle audio format (opus or m4a)', 'opus')
  .option('--strict', 'Fail compilation when SMIL target validation finds issues')
  .action(async (options) => {
    try {
      const profile = getProfile(options.profile);
      const audioFormat = parseAudioOutputFormat(options.audioFormat);
      await compileEPUB(
        options.input,
        options.output,
        options.zip,
        profile,
        options.strict ?? false,
        audioFormat,
      );
    } catch (err) {
      console.error('Compilation failed:', err);
      process.exit(1);
    }
  });

program
  .command('preview')
  .description('Generate a preview image for a specific timestamp')
  .requiredOption('-b, --bundle <path>', 'Input bundle directory path')
  .requiredOption('-t, --time <ms>', 'Timestamp in milliseconds')
  .option('-o, --output <path>', 'Output PNG path (default: preview.png)')
  .action(async (options) => {
    try {
      const bundlePath = resolve(options.bundle);
      const timestampMs = parseInt(options.time, 10);
      const outputPath = resolve(options.output || 'preview.png');

      console.log(`Generating preview at ${timestampMs}ms...`);

      const result = await previewAtTimestamp(bundlePath, timestampMs, outputPath);

      console.log(`Preview generated: ${outputPath}`);
      console.log(`  Page index: ${result.pageIndex}`);
      console.log(`  Active span: ${result.spanId}`);
      console.log(`  Timestamp: ${result.timestampMs}ms`);
    } catch (err) {
      console.error('Preview generation failed:', err);
      process.exit(1);
    }
  });

program
  .command('inspect')
  .description('Inspect a Cadence bundle and print alignment stats')
  .requiredOption('-b, --bundle <path>', 'Input bundle directory path')
  .action(async (options) => {
    try {
      const bundlePath = resolve(options.bundle);
      await inspectBundle(bundlePath);
    } catch (err) {
      console.error('Inspection failed:', err);
      process.exit(1);
    }
  });

program
  .command('align')
  .description('Align an EPUB with an audiobook using speech-to-text (requires parakeet-mlx)')
  .requiredOption('-e, --epub <path>', 'Input EPUB file path')
  .requiredOption('-a, --audio <path>', 'Input audiobook file or directory')
  .option('-o, --output <path>', 'Output bundle path (default: <epub>.bundle.zip)')
  .option('-p, --profile <name>', `Device profile (${Object.keys(profiles).join(', ')})`)
  .option('--no-zip', 'Output uncompressed bundle directory instead of ZIP')
  .option('--audio-format <format>', 'Bundle audio format (opus or m4a)', 'opus')
  .option('--keep-temp', 'Keep temporary files (for debugging)')
  .option('--transcription <path>', 'Use existing transcription JSON (skip parakeet-mlx)')
  .action(async (options) => {
    try {
      const profile = getProfile(options.profile);
      const audioFormat = parseAudioOutputFormat(options.audioFormat);
      await alignEPUB(
        options.epub,
        options.audio,
        options.output,
        options.zip,
        options.keepTemp ?? false,
        profile,
        audioFormat,
        options.transcription,
      );
    } catch (err) {
      console.error('Alignment failed:', err);
      process.exit(1);
    }
  });

function isCliEntrypoint(): boolean {
  const entrypointArg = process.argv[1];
  if (!entrypointArg) {
    return false;
  }

  return import.meta.url === pathToFileURL(entrypointArg).href;
}

if (isCliEntrypoint()) {
  program.parse();
}

const OFFSET_SEARCH_WINDOW_SIZE = 5000;

const BREAK_PROPERTY_ALIASES = new Map<string, string>([
  ['page-break-before', 'break-before'],
  ['page-break-after', 'break-after'],
  ['column-break-before', 'break-before'],
  ['column-break-after', 'break-after'],
  ['-webkit-column-break-before', 'break-before'],
  ['-webkit-column-break-after', 'break-after'],
]);

const BREAK_PROPERTIES = new Set<string>([
  'break-before',
  'break-after',
  ...BREAK_PROPERTY_ALIASES.keys(),
]);

const BREAK_CANONICAL_PROPERTIES = new Set<string>(['break-before', 'break-after']);

function normalizeEpubPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function resolveStylesheetPath(chapterPath: string, href: string): string | null {
  const cleanedHref = href.trim().split('#')[0]?.split('?')[0] ?? '';
  if (!cleanedHref) {
    return null;
  }

  if (/^(?:[a-z]+:|\/\/)/i.test(cleanedHref)) {
    return null;
  }

  const normalizedChapterPath = normalizeEpubPath(chapterPath);
  const chapterDir = posix.dirname(normalizedChapterPath);

  const resolved = cleanedHref.startsWith('/')
    ? posix.normalize(cleanedHref.replace(/^\/+/, ''))
    : posix.normalize(posix.join(chapterDir, cleanedHref));

  if (!resolved || resolved === '.' || resolved === '..' || resolved.startsWith('../')) {
    return null;
  }

  return normalizeEpubPath(resolved);
}

function getAttributeFromTag(tag: string, attributeName: string): string | null {
  const regex = new RegExp(
    `\\b${attributeName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  );
  const match = tag.match(regex);

  if (!match) {
    return null;
  }

  return match[2] ?? match[3] ?? match[4] ?? null;
}

function extractStylesheetHrefsFromRawHTML(html: string): string[] {
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if (!headMatch) {
    return [];
  }

  const hrefs: string[] = [];
  const seen = new Set<string>();
  const linkTagRegex = /<link\b[^>]*>/gi;

  let match: RegExpExecArray | null;
  while ((match = linkTagRegex.exec(headMatch[1])) !== null) {
    const linkTag = match[0];
    const rel = (getAttributeFromTag(linkTag, 'rel') || '').toLowerCase();
    const href = getAttributeFromTag(linkTag, 'href');

    if (!href) {
      continue;
    }

    const relTokens = rel.split(/\s+/).filter(Boolean);
    if (!relTokens.includes('stylesheet')) {
      continue;
    }

    if (!seen.has(href)) {
      seen.add(href);
      hrefs.push(href);
    }
  }

  return hrefs;
}

function extractInlineStyleBlocksFromRawHTML(html: string): string[] {
  const styleBlocks: string[] = [];
  const styleTagRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

  let match: RegExpExecArray | null;
  while ((match = styleTagRegex.exec(html)) !== null) {
    const css = match[1]?.trim();
    if (css) {
      styleBlocks.push(css);
    }
  }

  return styleBlocks;
}

function stripCssComments(input: string): string {
  return input.replace(/\/\*[\s\S]*?\*\//g, '');
}

function advancePastQuotedCssString(input: string, startIndex: number): number {
  const quote = input[startIndex];
  if (quote !== '"' && quote !== "'") {
    return startIndex;
  }

  let index = startIndex + 1;
  while (index < input.length) {
    const ch = input[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === quote) {
      return index;
    }
    index += 1;
  }

  return input.length - 1;
}

function readCssBlock(
  input: string,
  startIndex: number,
): { prelude: string; body: string; nextIndex: number } | null {
  let cursor = startIndex;
  while (cursor < input.length && /\s/.test(input[cursor]!)) {
    cursor += 1;
  }

  if (cursor >= input.length || input[cursor] === '}') {
    return null;
  }

  let openBraceIndex = -1;
  let searchIndex = cursor;

  while (searchIndex < input.length) {
    const ch = input[searchIndex]!;

    if (ch === '"' || ch === "'") {
      searchIndex = advancePastQuotedCssString(input, searchIndex);
      searchIndex += 1;
      continue;
    }

    if (ch === ';') {
      return {
        prelude: '',
        body: '',
        nextIndex: searchIndex + 1,
      };
    }

    if (ch === '{') {
      openBraceIndex = searchIndex;
      break;
    }

    if (ch === '}') {
      return {
        prelude: '',
        body: '',
        nextIndex: searchIndex + 1,
      };
    }

    searchIndex += 1;
  }

  if (openBraceIndex === -1) {
    return null;
  }

  const prelude = input.slice(cursor, openBraceIndex).trim();
  if (!prelude) {
    return {
      prelude: '',
      body: '',
      nextIndex: openBraceIndex + 1,
    };
  }

  let depth = 1;
  let bodyIndex = openBraceIndex + 1;

  while (bodyIndex < input.length && depth > 0) {
    const ch = input[bodyIndex]!;

    if (ch === '"' || ch === "'") {
      bodyIndex = advancePastQuotedCssString(input, bodyIndex);
      bodyIndex += 1;
      continue;
    }

    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }

    bodyIndex += 1;
  }

  if (depth !== 0) {
    return null;
  }

  const body = input.slice(openBraceIndex + 1, bodyIndex);
  return {
    prelude,
    body,
    nextIndex: bodyIndex + 1,
  };
}

function normalizeBreakValue(value: string): string {
  const important = /\s*!important\s*$/i.test(value);
  const withoutImportant = value.replace(/\s*!important\s*$/i, '').trim();
  if (!withoutImportant) {
    return '';
  }

  const lower = withoutImportant.toLowerCase();
  return `${lower}${important ? ' !important' : ''}`;
}

function toColumnBreakValue(value: string): string {
  const important = /\s*!important\s*$/i.test(value);
  const withoutImportant = value.replace(/\s*!important\s*$/i, '').trim();
  if (!withoutImportant) {
    return '';
  }

  const lower = withoutImportant.toLowerCase();

  let mapped = lower;
  if (
    lower === 'always' ||
    lower === 'page' ||
    lower === 'left' ||
    lower === 'right' ||
    lower === 'recto' ||
    lower === 'verso'
  ) {
    mapped = 'column';
  } else if (lower === 'avoid-page') {
    mapped = 'avoid';
  }

  return `${mapped}${important ? ' !important' : ''}`;
}

function filterBreakDeclarations(block: string): string[] {
  const declarations = block.split(';');
  const filtered: string[] = [];
  const seen = new Set<string>();

  for (const declaration of declarations) {
    const colonIndex = declaration.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const property = declaration.slice(0, colonIndex).trim().toLowerCase();
    const value = declaration.slice(colonIndex + 1).trim();
    if (!BREAK_PROPERTIES.has(property) || !value) {
      continue;
    }

    const normalizedValue = normalizeBreakValue(value);
    if (!normalizedValue) {
      continue;
    }

    const normalizedCanonicalValue = BREAK_CANONICAL_PROPERTIES.has(property)
      ? toColumnBreakValue(value)
      : normalizedValue;
    if (!normalizedCanonicalValue) {
      continue;
    }

    const canonicalDeclaration = `${property}: ${normalizedCanonicalValue};`;
    if (!seen.has(canonicalDeclaration)) {
      seen.add(canonicalDeclaration);
      filtered.push(canonicalDeclaration);
    }

    const aliasProperty = BREAK_PROPERTY_ALIASES.get(property);
    if (aliasProperty) {
      const aliasValue = toColumnBreakValue(value);
      if (!aliasValue) {
        continue;
      }

      const aliasDeclaration = `${aliasProperty}: ${aliasValue};`;
      if (!seen.has(aliasDeclaration)) {
        seen.add(aliasDeclaration);
        filtered.push(aliasDeclaration);
      }
    }
  }

  return filtered;
}

function extractBreakRulesFromCssContent(css: string): string[] {
  const rules: string[] = [];
  let cursor = 0;

  while (cursor < css.length) {
    const block = readCssBlock(css, cursor);
    if (!block) {
      break;
    }

    cursor = block.nextIndex;

    if (!block.prelude) {
      continue;
    }

    const prelude = block.prelude.trim();

    if (prelude.startsWith('@')) {
      const nestedRules = extractBreakRulesFromCssContent(block.body);
      if (nestedRules.length > 0) {
        const nested = nestedRules.map((rule) => `  ${rule.replace(/\n/g, '\n  ')}`).join('\n');
        rules.push(`${prelude} {\n${nested}\n}`);
        continue;
      }

      const declarations = filterBreakDeclarations(block.body);
      if (declarations.length > 0) {
        rules.push(`${prelude} { ${declarations.join(' ')} }`);
      }

      continue;
    }

    const declarations = filterBreakDeclarations(block.body);
    if (declarations.length === 0) {
      continue;
    }

    rules.push(`${prelude} { ${declarations.join(' ')} }`);
  }

  return rules;
}

export function extractBreakRulesFromCss(css: string): string[] {
  const withoutComments = stripCssComments(css);
  return extractBreakRulesFromCssContent(withoutComments);
}

async function extractBreakHintCssForChapter(
  container: EPUBContainer,
  chapterPath: string,
  xhtml: string,
): Promise<string> {
  const cssSources: string[] = [];

  cssSources.push(...extractInlineStyleBlocksFromRawHTML(xhtml));

  const stylesheetHrefs = extractStylesheetHrefsFromRawHTML(xhtml);
  for (const href of stylesheetHrefs) {
    const stylesheetPath = resolveStylesheetPath(chapterPath, href);
    if (!stylesheetPath) {
      continue;
    }

    try {
      const stylesheetBuffer = await container.readFile(stylesheetPath);
      cssSources.push(stylesheetBuffer.toString('utf-8'));
    } catch {
      console.warn(`  Warning: Could not read stylesheet "${href}" for ${chapterPath}`);
    }
  }

  const breakRules: string[] = [];
  const seenRules = new Set<string>();

  for (const css of cssSources) {
    for (const rule of extractBreakRulesFromCss(css)) {
      if (seenRules.has(rule)) {
        continue;
      }
      seenRules.add(rule);
      breakRules.push(rule);
    }
  }

  return breakRules.join('\n');
}

async function loadTranscriptionFromFile(
  transcriptionPath: string,
  trackPaths: string[],
): Promise<Transcription> {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(resolve(transcriptionPath), 'utf-8'));

  const defaultAudiofile = trackPaths[0] ?? '';

  return {
    transcript: raw.transcript,
    wordTimeline: raw.wordTimeline.map((entry: any) => ({
      text: entry.text,
      startTime: entry.startTime,
      endTime: entry.endTime,
      startOffsetUtf16: entry.startOffsetUtf16,
      endOffsetUtf16: entry.endOffsetUtf16,
      audiofile: entry.audiofile ?? defaultAudiofile,
    })),
  };
}

async function inspectBundle(bundlePath: string): Promise<void> {
  const bundle = await loadBundle(bundlePath);
  const { meta, spans, pages } = bundle;

  const timedSpans = spans.filter(
    (span) => span.clipBeginMs >= 0 && span.clipEndMs > span.clipBeginMs,
  );
  const untimedSpans = spans.length - timedSpans.length;

  const durations = timedSpans.map((span) => span.clipEndMs - span.clipBeginMs);
  const durationTotal = durations.reduce((sum, value) => sum + value, 0);
  const durationMin = durations.length ? Math.min(...durations) : 0;
  const durationMax = durations.length ? Math.max(...durations) : 0;
  const durationAvg = durations.length ? durationTotal / durations.length : 0;

  const sortedTimed = [...timedSpans].sort((a, b) => a.clipBeginMs - b.clipBeginMs);
  const firstTimed = sortedTimed[0];
  const lastTimed = sortedTimed[sortedTimed.length - 1];

  const gaps: { gapMs: number; fromId: string; toId: string }[] = [];
  for (let i = 1; i < sortedTimed.length; i++) {
    const prev = sortedTimed[i - 1]!;
    const next = sortedTimed[i]!;
    const gapMs = next.clipBeginMs - prev.clipEndMs;
    if (gapMs > 0) {
      gaps.push({ gapMs, fromId: prev.id, toId: next.id });
    }
  }

  const totalGapMs = gaps.reduce((sum, gap) => sum + gap.gapMs, 0);
  const maxGap = gaps.reduce((best, gap) => (gap.gapMs > best.gapMs ? gap : best), {
    gapMs: 0,
    fromId: '',
    toId: '',
  });

  const pageStats = new Map<number, { timed: number; untimed: number }>();
  for (const span of spans) {
    const entry = pageStats.get(span.pageIndex) ?? { timed: 0, untimed: 0 };
    if (span.clipBeginMs >= 0 && span.clipEndMs > span.clipBeginMs) {
      entry.timed += 1;
    } else {
      entry.untimed += 1;
    }
    pageStats.set(span.pageIndex, entry);
  }

  const pagesWithNoTimed = pages.filter(
    (page) => (pageStats.get(page.pageIndex)?.timed ?? 0) === 0,
  );
  const pagesWithNoSpans = pages.filter((page) => !pageStats.has(page.pageIndex));
  const topUntimedPages = [...pageStats.entries()]
    .filter(([pageIndex]) => pageIndex >= 0)
    .sort((a, b) => b[1].untimed - a[1].untimed)
    .slice(0, 5);

  const spanPageMap = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const spanRect of page.spanRects) {
      const entry = spanPageMap.get(spanRect.spanId) ?? new Set<number>();
      entry.add(page.pageIndex);
      spanPageMap.set(spanRect.spanId, entry);
    }
  }

  const multiPageSpans = [...spanPageMap.entries()]
    .filter(([, pageSet]) => pageSet.size > 1)
    .map(([spanId, pageSet]) => ({
      spanId,
      pages: [...pageSet].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.pages.length - a.pages.length);

  const spansMissingRects = spans.filter((span) => !spanPageMap.has(span.id));
  const pagesWithNoTextRuns = pages.filter((page) => page.textRuns.length === 0);

  const formatMs = (ms: number) => {
    if (!Number.isFinite(ms)) return 'n/a';
    const totalSeconds = Math.floor(ms / 1000);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    return hours > 0
      ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
      : `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  console.log('Bundle inspection');
  console.log('=================');
  console.log(`Path: ${bundlePath}`);
  console.log(`Title: ${meta.title}`);
  console.log(`Profile: ${meta.profile}`);
  console.log(`Audio file: ${meta.audioFile}`);
  console.log(`Pages: ${pages.length}`);
  console.log(`Spans: ${spans.length}`);
  console.log(`Timed spans: ${timedSpans.length}`);
  console.log(`Untimed spans: ${untimedSpans}`);

  if (timedSpans.length > 0) {
    console.log('');
    console.log('Timing stats');
    console.log('------------');
    console.log(`First timed span: ${firstTimed?.id} @ ${formatMs(firstTimed?.clipBeginMs ?? 0)}`);
    console.log(`Last timed span: ${lastTimed?.id} @ ${formatMs(lastTimed?.clipEndMs ?? 0)}`);
    console.log(
      `Span duration min/avg/max: ${durationMin.toFixed(0)} / ${durationAvg.toFixed(0)} / ${durationMax.toFixed(0)} ms`,
    );
    console.log(`Total gap time: ${formatMs(totalGapMs)} (${gaps.length} gaps)`);
    if (maxGap.gapMs > 0) {
      console.log(
        `Largest gap: ${formatMs(maxGap.gapMs)} between ${maxGap.fromId} -> ${maxGap.toId}`,
      );
    }
  }

  console.log('');
  console.log('Page stats');
  console.log('----------');
  console.log(`Pages with no timed spans: ${pagesWithNoTimed.length}`);
  console.log(`Pages with no spans: ${pagesWithNoSpans.length}`);
  console.log(`Pages with no text runs: ${pagesWithNoTextRuns.length}`);

  if (topUntimedPages.length > 0) {
    console.log('Top pages by untimed spans:');
    for (const [pageIndex, stats] of topUntimedPages) {
      console.log(`  Page ${pageIndex}: ${stats.untimed} untimed, ${stats.timed} timed`);
    }
  }

  console.log('');
  console.log('Span coverage');
  console.log('-------------');
  console.log(`Spans missing rects: ${spansMissingRects.length}`);
  console.log(`Spans split across pages: ${multiPageSpans.length}`);

  if (multiPageSpans.length > 0) {
    console.log('Top split spans:');
    for (const entry of multiPageSpans.slice(0, 10)) {
      const pagesList =
        entry.pages.length > 6 ? `${entry.pages.slice(0, 6).join(', ')}…` : entry.pages.join(', ');
      console.log(`  ${entry.spanId} -> [${pagesList}]`);
    }
  }
}

/**
 * Find the best offset in the transcription for a chapter's text.
 */
function findChapterOffset(
  chapterSentences: string[],
  transcription: Transcription,
  lastOffset: number,
): { startSentence: number; transcriptionOffset: number | null } {
  const transcriptionText = transcription.transcript;

  let i = 0;
  while (i < transcriptionText.length) {
    let startSentence = 0;

    const proposedStartIndex = (lastOffset + i) % transcriptionText.length;
    const proposedEndIndex =
      (proposedStartIndex + OFFSET_SEARCH_WINDOW_SIZE) % transcriptionText.length;

    const wrapping = proposedEndIndex < proposedStartIndex;
    const endIndex = wrapping ? transcriptionText.length : proposedEndIndex;
    const startIndex = proposedStartIndex;

    if (startIndex < endIndex) {
      const transcriptionTextSlice = transcriptionText.slice(startIndex, endIndex);

      // Normalize transcription slice once per window to avoid repeated work
      const normalizeText = (s: string) =>
        s
          .toLowerCase()
          .replace(/[\r\n\t]+/g, ' ') // Collapse newlines/tabs to space
          .replace(/\s+/g, ' ') // Collapse multiple spaces
          .replace(/[—–]/g, '-') // Normalize dashes
          .replace(/['']/g, "'") // Normalize quotes
          .replace(/[""]/g, '"')
          .trim();

      const normalizedTranscriptionSlice = normalizeText(transcriptionTextSlice);

      while (startSentence < chapterSentences.length) {
        const queryString = chapterSentences.slice(startSentence, startSentence + 6).join(' ');
        const normalizedQuery = normalizeText(queryString);

        const firstMatch = findNearestMatch(
          normalizedQuery,
          normalizedTranscriptionSlice,
          Math.max(Math.floor(0.15 * normalizedQuery.length), 2), // Slightly more tolerant
        );

        if (firstMatch) {
          return {
            startSentence,
            transcriptionOffset: (firstMatch.index + startIndex) % transcriptionText.length,
          };
        }

        startSentence += 3;
      }
    }

    if (wrapping) {
      i += transcriptionText.length - proposedStartIndex;
    } else {
      i += Math.floor(OFFSET_SEARCH_WINDOW_SIZE / 2);
    }
  }

  return { startSentence: 0, transcriptionOffset: null };
}

/**
 * Align EPUB with audiobook using parakeet-mlx
 */
async function alignEPUB(
  epubPath: string,
  audioPath: string,
  outputPath: string | undefined,
  createZip: boolean,
  keepTemp: boolean,
  profile: DeviceProfile,
  audioFormat: AudioOutputFormat,
  transcriptionPath?: string,
): Promise<void> {
  const resolvedEpub = resolve(epubPath);
  const resolvedAudio = resolve(audioPath);
  const defaultOutput = resolvedEpub.replace(/\.epub$/i, '.bundle.zip');
  const resolvedOutput = outputPath ? resolve(outputPath) : defaultOutput;

  console.log('Cadence Alignment v0.1.0');
  console.log('========================');
  console.log(`EPUB:   ${resolvedEpub}`);
  console.log(`Audio:  ${resolvedAudio}`);
  console.log(`Output: ${resolvedOutput}`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Audio format: ${audioFormat}`);
  console.log('');

  // Create temp directory for extracted chapters
  const tempDir = await mkdtemp(join(tmpdir(), 'cadence-align-'));
  console.log(`Temp directory: ${tempDir}`);

  try {
    // Step 1: Prepare audio tracks
    console.log('');
    console.log('Step 1: Preparing audio tracks...');
    const tracks = await prepareAudioTracks(resolvedAudio, tempDir);
    console.log(`  Found ${tracks.length} audio track(s)`);
    for (const track of tracks) {
      console.log(`    - ${basename(track.path)} (${(track.duration / 60).toFixed(1)} min)`);
    }

    // Step 2: Transcribe audio
    console.log('');
    console.log('Step 2: Transcribing audio with parakeet-mlx...');
    console.log('  (This may take a while for long audiobooks)');

    const trackPaths = tracks.map((t) => t.path);

    const transcription = transcriptionPath
      ? await loadTranscriptionFromFile(transcriptionPath, trackPaths)
      : await transcribeMultiple(trackPaths);

    console.log(`  Transcript length: ${transcription.transcript.length} chars`);
    console.log(`  Word timeline entries: ${transcription.wordTimeline.length}`);

    // Step 3: Open EPUB and parse
    console.log('');
    console.log('Step 3: Opening EPUB...');
    const container = await openEPUB(resolvedEpub);

    try {
      const opf = await parseOPF(container);
      console.log(`  Title: ${opf.title}`);

      const spineFiles = getSpineXHTMLFiles(opf);
      console.log(`  Spine items: ${spineFiles.length}`);

      console.log('Step 3b: Scanning for unsupported/degraded EPUB features...');
      try {
        const featureScan = await scanUnsupportedFeatures(container, opf, spineFiles);
        logUnsupportedFeatureScanResult(featureScan);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`  Warning: Unsupported-feature scan failed: ${message}`);
      }

      // Step 4: Process each chapter - extract sentences, align, tag
      console.log('');
      console.log('Step 4: Aligning chapters with audio...');

      const allSpans: Span[] = [];
      const normalizedContents: NormalizedContent[] = [];
      let lastTranscriptionOffset = 0;
      let lastSentenceRange: SentenceRange | null = null;

      for (let i = 0; i < spineFiles.length; i++) {
        const chapter = spineFiles[i];
        console.log(`  Processing: ${chapter.href}`);

        // Read chapter XHTML
        const xhtmlContent = await container.readFile(chapter.href);
        const xhtml = xhtmlContent.toString('utf-8');

        // Extract sentences
        const sentences = extractSentences(xhtml);
        console.log(`    Sentences: ${sentences.length}`);

        if (sentences.length === 0) {
          console.log(`    Skipping (no text)`);
          continue;
        }

        // Find chapter offset in transcription
        // Skip searching if we've consumed most of the transcription (single audio track)
        const transcriptionConsumedPct =
          (lastTranscriptionOffset / transcription.transcript.length) * 100;

        let startSentence = 0;
        let transcriptionOffset: number | null = null;

        if (tracks.length === 1 && transcriptionConsumedPct > 80) {
          // Skip expensive search - we've consumed most of the audio
          if (lastTranscriptionOffset < transcription.transcript.length) {
            transcriptionOffset = lastTranscriptionOffset;
          }
        } else {
          const result = findChapterOffset(sentences, transcription, lastTranscriptionOffset);
          startSentence = result.startSentence;
          transcriptionOffset = result.transcriptionOffset;
        }

        if (transcriptionOffset === null) {
          console.log(`    Could not find matching audio - skipping`);
          continue;
        }

        console.log(`    Matched at offset ${transcriptionOffset}, sentence ${startSentence}`);

        // Get sentence ranges (timing)
        const { sentenceRanges, transcriptionOffset: endOffset } = await getSentenceRanges(
          startSentence,
          transcription,
          sentences,
          transcriptionOffset,
          lastSentenceRange,
        );

        // Interpolate missing ranges
        const interpolated = await interpolateSentenceRanges(sentenceRanges, lastSentenceRange);
        const expanded = expandEmptySentenceRanges(interpolated);

        console.log(`    Aligned ${expanded.length} sentence ranges`);

        // Tag only aligned sentences in XHTML.
        // This avoids mutating unrelated front matter/content that has no timing.
        const alignedSentenceIndices = new Set(
          expanded.filter((range) => range.start >= 0 && range.end >= 0).map((range) => range.id),
        );
        const { html: taggedHtml } = tagSentencesInXhtml(
          xhtml,
          chapter.id,
          alignedSentenceIndices,
        );

        // Create spans from sentence ranges
        for (const range of expanded) {
          const spanId = `${chapter.id}-sentence${range.id}`;
          const clipBeginMs = range.start < 0 ? -1 : Math.round(range.start * 1000);
          const clipEndMs = range.end < 0 ? -1 : Math.round(range.end * 1000);

          allSpans.push({
            id: spanId,
            chapterId: chapter.id,
            textRef: `${chapter.href}#${spanId}`,
            audioSrc: range.audiofile,
            clipBeginMs,
            clipEndMs,
          });
        }

        const breakHintCss = await extractBreakHintCssForChapter(container, chapter.href, xhtml);

        // Normalize for Chromium rendering
        // We keep base typography deterministic while preserving source break hints.
        normalizedContents.push({
          chapterId: chapter.id,
          xhtmlPath: chapter.href,
          html: generateNormalizedAlignedHTML(taggedHtml, profile, chapter.id, breakHintCss),
          spanIds: expanded.map((r) => `${chapter.id}-sentence${r.id}`),
        });

        lastTranscriptionOffset = endOffset;
        lastSentenceRange = expanded[expanded.length - 1] ?? null;
      }

      console.log(`  Total spans: ${allSpans.length}`);

      // Step 5: Paginate with Playwright
      console.log('');
      console.log('Step 5: Paginating content...');
      await initBrowser();

      const paginatedPages = await paginateChapters(normalizedContents, profile, container);
      console.log(`  Total pages: ${paginatedPages.length}`);

      const splitResult = splitSpansAcrossPages(allSpans, paginatedPages);
      const compactResult = compactSpanIds(splitResult.spans, splitResult.pages);
      const spans = compactResult.spans;
      const pages = compactResult.pages;

      if (splitResult.splitSpanCount > 0) {
        console.log(
          `  Split ${splitResult.splitSpanCount} span(s) across page boundaries (+${splitResult.createdSpanCount} span entries)`,
        );
      }

      // Step 6: Assign spans to pages
      console.log('Step 6: Mapping spans to pages...');
      const spanToPageIndex = assignSpansToPages(pages);
      console.log(`  Mapped ${spanToPageIndex.size} spans to pages`);

      // Build ToC from EPUB navigation (EPUB3 nav, NCX fallback)
      const toc = await buildTocEntries(container, opf, spineFiles, pages);

      // Step 7: Prepare audio files for bundle
      console.log('Step 7: Preparing audio files...');

      // Step 8: Write bundle
      console.log('Step 8: Writing bundle...');

      const bundleId =
        opf.identifier?.trim().replace(/\s+/g, '-') ||
        createHash('sha256').update(opf.title).digest('hex').slice(0, 16);

      const meta: BundleMeta = {
        bundleVersion: '1.0.0',
        bundleId,
        profile: profile.name,
        title: opf.title,
        audioFile: getAudioFileName(audioFormat),
        pages: pages.length,
        spans: spans.length,
      };

      if (createZip) {
        await writeBundleAligned(
          resolvedOutput,
          meta,
          spans,
          pages,
          spanToPageIndex,
          toc,
          tracks,
          audioFormat,
        );
      } else {
        const uncompressedDir = resolvedOutput.replace(/\.zip$/, '');
        await writeBundleAlignedUncompressed(
          uncompressedDir,
          meta,
          spans,
          pages,
          spanToPageIndex,
          toc,
          tracks,
          audioFormat,
        );
        console.log(`  Bundle written to: ${uncompressedDir}`);
      }

      console.log('');
      console.log('Alignment complete!');
      console.log(`  Pages: ${meta.pages}`);
      console.log(`  Spans: ${meta.spans}`);
    } finally {
      await container.close();
    }
  } finally {
    if (!keepTemp) {
      console.log('');
      console.log('Cleaning up temp directory...');
      await rm(tempDir, { recursive: true, force: true });
    } else {
      console.log(`Temp files kept at: ${tempDir}`);
    }
    await closeBrowser();
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Generate normalized HTML for aligned content.
 *
 * Keep this intentionally narrow/safe: we apply deterministic book-like defaults
 * (paragraph indents/spacing + pre whitespace) without importing full publisher CSS,
 * which can introduce complex layout behavior that breaks column pagination.
 */
function generateNormalizedAlignedHTML(
  taggedHtml: string,
  profile: DeviceProfile,
  chapterId: string,
  breakHintCss: string,
): string {
  // Extract body content from the tagged HTML
  const bodyMatch = taggedHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1] : taggedHtml;

  const contentWidth = profile.viewportWidth - profile.margins.left - profile.margins.right;
  const contentHeight = profile.viewportHeight - profile.margins.top - profile.margins.bottom;
  const tunedLineHeight = Number((profile.lineHeight + 0.06).toFixed(2));

  const css = `
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    html, body {
      width: ${profile.viewportWidth}px;
      height: ${profile.viewportHeight}px;
      overflow: hidden;
    }
    body {
      font-family: ${profile.fontFamily};
      font-size: ${profile.fontSize}px;
      line-height: ${tunedLineHeight};
      padding: ${profile.margins.top}px ${profile.margins.right}px ${profile.margins.bottom}px ${profile.margins.left}px;
      text-rendering: optimizeLegibility;
      font-kerning: normal;
    }
    .cadence-content {
      width: ${contentWidth}px;
      height: ${contentHeight}px;
      overflow-y: scroll;
      overflow-x: hidden;
    }
    .cadence-content p {
      text-align: justify;
      text-indent: 1em;
      margin-top: 0.25em;
      margin-bottom: 0.25em;
      margin-left: 0.5em;
      margin-right: 0.5em;
    }
    .cadence-content p:first-child,
    .cadence-content h1 + p,
    .cadence-content h2 + p,
    .cadence-content h3 + p,
    .cadence-content h4 + p,
    .cadence-content h5 + p,
    .cadence-content h6 + p {
      text-indent: 0;
    }
    .cadence-content h1,
    .cadence-content h2,
    .cadence-content h3,
    .cadence-content h4,
    .cadence-content h5,
    .cadence-content h6 {
      text-align: center;
      margin-top: 1em;
      margin-bottom: 0.75em;
    }
    .cadence-content blockquote {
      margin-left: 1.5em;
      margin-right: 0;
    }
    .cadence-content pre {
      white-space: pre-wrap;
      text-indent: 0;
      margin-left: 1.5em;
      margin-top: 0.5em;
      margin-bottom: 0.5em;
      font-family: ${profile.fontFamily};
    }
    ${breakHintCss ? `
    /* Preserved source break hints (generic) */
    ${breakHintCss}
    ` : ''}
    /* Strip complex layouts that break CSS columns */
    table, tr, td, th {
      display: block !important;
      width: auto !important;
      padding: 0 !important;
      float: none !important;
    }
    * {
      float: none !important;
      max-width: 100% !important;
    }
    img { max-width: 100% !important; height: auto !important; }
  `;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${profile.viewportWidth}, height=${profile.viewportHeight}">
  <style>${css}</style>
</head>
<body>
  <div class="cadence-content" data-chapter-id="${escapeAttr(chapterId)}">
    ${bodyContent}
  </div>
</body>
</html>`;
}

/**
 * Write bundle with aligned audio (from tracks, not from EPUB)
 */
async function writeBundleAligned(
  outputPath: string,
  meta: BundleMeta,
  spans: Span[],
  pages: Page[],
  spanToPageIndex: Map<string, number>,
  toc: TocEntry[],
  tracks: { path: string; duration: number; title?: string }[],
  audioFormat: AudioOutputFormat,
): Promise<void> {
  const { existsSync, rmSync, mkdirSync, createWriteStream } = await import('node:fs');
  const archiver = (await import('archiver')).default;

  // Write to temp directory first
  const tempDir = outputPath.replace(/\.zip$/, '_temp');

  try {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
    mkdirSync(tempDir, { recursive: true });

    await writeBundleAlignedUncompressed(
      tempDir,
      meta,
      spans,
      pages,
      spanToPageIndex,
      toc,
      tracks,
      audioFormat,
    );

    // Create ZIP archive
    if (existsSync(outputPath)) {
      rmSync(outputPath);
    }

    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve());
      archive.on('error', (err) => reject(err));

      archive.pipe(output);
      archive.directory(tempDir, false);
      archive.finalize();
    });

    console.log(`  Bundle written to: ${outputPath}`);
  } finally {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  }
}

/**
 * Write uncompressed bundle with aligned audio
 */
async function writeBundleAlignedUncompressed(
  outputDir: string,
  meta: BundleMeta,
  spans: Span[],
  pages: Page[],
  spanToPageIndex: Map<string, number>,
  toc: TocEntry[],
  tracks: { path: string; duration: number; title?: string }[],
  audioFormat: AudioOutputFormat,
): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { existsSync, rmSync } = await import('node:fs');
  const { concatenateAudioFiles, applyAudioOffsets } = await import('./audio/concat.js');

  // Clean output directory to avoid stale pages
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true });
  }

  // Create directories
  await mkdir(outputDir, { recursive: true });
  await mkdir(join(outputDir, 'pages'), { recursive: true });

  // Concatenate audio files into a single bundle audio file
  const audioOutputPath = join(outputDir, meta.audioFile);
  const trackPaths = tracks.map((t) => t.path);
  const concatResult = await concatenateAudioFiles(trackPaths, audioOutputPath, audioFormat);

  // Apply audio offsets to spans (modifies in place)
  applyAudioOffsets(spans, concatResult.offsets);

  // Write meta.json
  await writeFile(join(outputDir, 'meta.json'), JSON.stringify(meta));

  // Write toc.json
  await writeFile(join(outputDir, 'toc.json'), JSON.stringify(toc));

  // Write spans.jsonl (same format as compile command)
  const spansContent = spans
    .map((span) => {
      const pageIndex = spanToPageIndex.get(span.id) ?? -1;
      return JSON.stringify({
        id: span.id,
        clipBeginMs: span.clipBeginMs,
        clipEndMs: span.clipEndMs,
        pageIndex,
      });
    })
    .join('\n');
  await writeFile(join(outputDir, 'spans.jsonl'), spansContent);

  const compactedPages = compactPageStyles(pages);

  // Write shared styles table
  await writeFile(join(outputDir, 'styles.json'), JSON.stringify(compactedPages.styles));

  // Write pages (with styleId references)
  for (const page of compactedPages.pages) {
    await writeFile(join(outputDir, 'pages', `${page.pageIndex}.json`), JSON.stringify(page));
  }
}

/**
 * Main compilation pipeline
 */
async function compileEPUB(
  inputPath: string,
  outputPath: string | undefined,
  createZip: boolean,
  profile: DeviceProfile,
  strictSmilValidation: boolean,
  audioFormat: AudioOutputFormat,
): Promise<void> {
  const resolvedInput = resolve(inputPath);
  const defaultOutput = resolvedInput.replace(/\.epub$/i, '.bundle.zip');
  const resolvedOutput = outputPath ? resolve(outputPath) : defaultOutput;

  console.log('Cadence Compiler v0.1.0');
  console.log('========================');
  console.log(`Input:  ${resolvedInput}`);
  console.log(`Output: ${resolvedOutput}`);
  console.log(`Profile: ${profile.name}`);
  console.log(`Audio format: ${audioFormat}`);
  if (strictSmilValidation) {
    console.log('Strict SMIL target validation: enabled');
  }
  console.log('');

  // Step 1: Open EPUB
  console.log('Step 1: Opening EPUB...');
  const container = await openEPUB(resolvedInput);

  try {
    // Step 2: Parse OPF
    console.log('Step 2: Parsing OPF...');
    const opf = await parseOPF(container);
    console.log(`  Title: ${opf.title}`);

    // Get linear spine XHTML files (includes content with and without media overlays)
    const spineFiles = getSpineXHTMLFiles(opf);
    console.log(`  Spine items: ${spineFiles.length}`);

    console.log('Step 2b: Scanning for unsupported/degraded EPUB features...');
    try {
      const featureScan = await scanUnsupportedFeatures(container, opf, spineFiles);
      logUnsupportedFeatureScanResult(featureScan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  Warning: Unsupported-feature scan failed: ${message}`);
    }

    const chaptersWithSMIL = spineFiles.filter((f) => f.smilHref);
    console.log(`  Chapters with media overlays: ${chaptersWithSMIL.length}`);
    console.log(`  Chapters without media overlays: ${spineFiles.length - chaptersWithSMIL.length}`);

    if (chaptersWithSMIL.length === 0) {
      throw new Error('No chapters with media overlays found in this EPUB');
    }

    // Step 3: Parse SMIL files
    console.log('Step 3: Parsing SMIL files...');
    const allSpans: Span[] = [];

    for (const chapter of chaptersWithSMIL) {
      if (!chapter.smilHref) continue;

      console.log(`  Parsing: ${chapter.smilHref}`);
      const spans = await parseChapterSMIL(container, chapter.smilHref, chapter.id);
      console.log(`    Found ${spans.length} spans`);
      allSpans.push(...spans);
    }

    console.log(`  Total spans: ${allSpans.length}`);

    // Step 4: Normalize XHTML
    console.log('Step 4: Normalizing XHTML...');
    const normalizedContents: NormalizedContent[] = [];

    for (const chapter of spineFiles) {
      console.log(`  Normalizing: ${chapter.href}`);
      const content = await normalizeXHTML(container, chapter.href, chapter.id, allSpans, profile);
      normalizedContents.push(content);
    }

    // Step 5: Paginate with Playwright
    console.log('Step 5: Paginating content...');
    await initBrowser();

    const paginatedPages = await paginateChapters(normalizedContents, profile, container);
    console.log(`  Total pages: ${paginatedPages.length}`);

    console.log('Step 5b: Validating SMIL-to-DOM target mapping...');
    const smilTargetValidation = validateSmilToDomTargets(allSpans, paginatedPages, normalizedContents);
    logSmilToDomValidationResult(smilTargetValidation);

    if (strictSmilValidation && smilTargetValidation.issues.length > 0) {
      throw new Error(
        `Strict SMIL validation failed: ` +
          `${smilTargetValidation.unresolvedTextRefCount} unresolved textRef target(s), ` +
          `${smilTargetValidation.timedSpansWithoutGeometryCount} timed span(s) with no mapped geometry/text`,
      );
    }

    const splitResult = splitSpansAcrossPages(allSpans, paginatedPages);
    const compactResult = compactSpanIds(splitResult.spans, splitResult.pages);
    const spans = compactResult.spans;
    const pages = compactResult.pages;

    if (splitResult.splitSpanCount > 0) {
      console.log(
        `  Split ${splitResult.splitSpanCount} span(s) across page boundaries (+${splitResult.createdSpanCount} span entries)`,
      );
    }

    // Step 6: Assign spans to pages and build ToC
    console.log('Step 6: Mapping spans to pages...');
    const spanToPageIndex = assignSpansToPages(pages);
    console.log(`  Mapped ${spanToPageIndex.size} spans to pages`);

    // Build table of contents from EPUB navigation (EPUB3 nav, NCX fallback)
    const toc = await buildTocEntries(container, opf, spineFiles, pages);
    console.log(`  ToC entries: ${toc.length}`);

    // Step 7: Collect audio files
    console.log('Step 7: Collecting audio files...');
    const audioFiles = getAudioFilesInFirstSpanUseOrder(opf, spans);
    console.log(`  Audio files: ${audioFiles.length}`);

    // Step 8: Write bundle
    console.log('Step 8: Writing bundle...');

    // Generate stable bundle ID from dc:identifier or fallback to hash
    let bundleId: string;
    if (opf.identifier?.trim()) {
      // Use dc:identifier (often ISBN) - clean it up
      bundleId = opf.identifier.trim().replace(/\s+/g, '-');
    } else {
      // Fallback: hash of title + spine order for deterministic ID
      const spineIds = opf.spine.map((s) => s.idref).join(',');
      const hashInput = `${opf.title}|${spineIds}`;
      bundleId = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
    }

    const meta: BundleMeta = {
      bundleVersion: '1.0.0',
      bundleId,
      profile: profile.name,
      title: opf.title,
      audioFile: getAudioFileName(audioFormat),
      pages: pages.length,
      spans: spans.length,
    };

    if (createZip) {
      await writeBundle(
        resolvedOutput,
        meta,
        spans,
        pages,
        spanToPageIndex,
        toc,
        audioFiles,
        container,
        audioFormat,
      );
    } else {
      const uncompressedDir = resolvedOutput.replace(/\.zip$/, '');
      await writeBundleUncompressed(
        uncompressedDir,
        meta,
        spans,
        pages,
        spanToPageIndex,
        toc,
        audioFiles,
        container,
        audioFormat,
      );
    }

    // Step 9: Validate output
    console.log('Step 9: Validating output...');
    const validationResult = validateCompilationResult(spans, pages, spanToPageIndex, profile);
    logValidationResult(validationResult);

    console.log('');
    console.log('Compilation complete!');
    console.log(`  Pages: ${meta.pages}`);
    console.log(`  Spans: ${meta.spans}`);
  } finally {
    await container.close();
    await closeBrowser();
  }
}

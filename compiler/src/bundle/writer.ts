import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import archiver from 'archiver';
import { type AudioOutputFormat, applyAudioOffsets, concatenateAudio } from '../audio/concat.js';
import { compactPageStyles } from './compact-page-styles.js';
import type {
  BundleMeta,
  EPUBContainer,
  Page,
  SerializedPage,
  Span,
  SpanEntry,
  TextStyle,
  TocEntry,
} from '../types.js';

/**
 * Write the compiled bundle to a ZIP file
 */
export async function writeBundle(
  outputPath: string,
  meta: BundleMeta,
  spans: Span[],
  pages: Page[],
  spanToPageIndex: Map<string, number>,
  toc: TocEntry[],
  audioFiles: string[],
  container: EPUBContainer,
  audioFormat: AudioOutputFormat,
): Promise<void> {
  // Create a temporary directory for bundle contents
  const tempDir = outputPath.replace(/\.zip$/, '_temp');

  try {
    // Clean up any existing temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
    mkdirSync(tempDir, { recursive: true });

    // Concatenate audio files into a single bundle audio file
    const audioOutputPath = join(tempDir, meta.audioFile);
    const concatResult = await concatenateAudio(audioFiles, container, audioOutputPath, audioFormat);

    // Apply audio offsets to spans (modifies in place)
    applyAudioOffsets(spans, concatResult.offsets);

    // Write meta.json
    await writeMetaJson(tempDir, meta);

    // Write toc.json
    await writeTocJson(tempDir, toc);

    // Write spans.jsonl (with updated timestamps)
    await writeSpansJsonl(tempDir, spans, spanToPageIndex);

    // Write styles + pages
    await writeStylesAndPages(tempDir, pages);

    // Create ZIP archive
    await createZipArchive(tempDir, outputPath);

    console.log(`Bundle written to: ${outputPath}`);
  } finally {
    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  }
}

/**
 * Write meta.json file
 */
async function writeMetaJson(dir: string, meta: BundleMeta): Promise<void> {
  const metaPath = join(dir, 'meta.json');
  await writeFile(metaPath, JSON.stringify(meta));
}

/**
 * Write toc.json file
 */
async function writeTocJson(dir: string, toc: TocEntry[]): Promise<void> {
  const tocPath = join(dir, 'toc.json');
  await writeFile(tocPath, JSON.stringify(toc));
}

/**
 * Write spans.jsonl file (one JSON object per line)
 * Timestamps are global offsets into the single bundle audio file
 */
async function writeSpansJsonl(
  dir: string,
  spans: Span[],
  spanToPageIndex: Map<string, number>,
): Promise<void> {
  const spansPath = join(dir, 'spans.jsonl');
  const lines: string[] = [];

  for (const span of spans) {
    const entry: SpanEntry = {
      id: span.id,
      clipBeginMs: span.clipBeginMs,
      clipEndMs: span.clipEndMs,
      pageIndex: spanToPageIndex.get(span.id) ?? -1,
    };
    lines.push(JSON.stringify(entry));
  }

  await writeFile(spansPath, lines.join('\n'));
}

/**
 * Write styles.json file (shared text style table)
 */
async function writeStylesJson(dir: string, styles: TextStyle[]): Promise<void> {
  const stylesPath = join(dir, 'styles.json');
  await writeFile(stylesPath, JSON.stringify(styles));
}

/**
 * Write page JSON files (serialized with styleId references)
 */
async function writePages(dir: string, pages: SerializedPage[]): Promise<void> {
  const pagesDir = join(dir, 'pages');
  await mkdir(pagesDir, { recursive: true });

  for (const page of pages) {
    const pagePath = join(pagesDir, `${page.pageId}.json`);
    await writeFile(pagePath, JSON.stringify(page));
  }
}

/**
 * Write styles table and compact pages
 */
async function writeStylesAndPages(dir: string, pages: Page[]): Promise<void> {
  const compacted = compactPageStyles(pages);
  await writeStylesJson(dir, compacted.styles);
  await writePages(dir, compacted.pages);
}

/**
 * Create a ZIP archive from a directory using archiver
 */
async function createZipArchive(sourceDir: string, outputPath: string): Promise<void> {
  // Remove existing output file if present
  if (existsSync(outputPath)) {
    rmSync(outputPath);
  }

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 }, // Maximum compression
    });

    output.on('close', () => {
      resolve();
    });

    archive.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);

    // Add all files from the source directory
    archive.directory(sourceDir, false);

    archive.finalize();
  });
}

/**
 * Write bundle without zipping (for debugging)
 */
export async function writeBundleUncompressed(
  outputDir: string,
  meta: BundleMeta,
  spans: Span[],
  pages: Page[],
  spanToPageIndex: Map<string, number>,
  toc: TocEntry[],
  audioFiles: string[],
  container: EPUBContainer,
  audioFormat: AudioOutputFormat,
): Promise<void> {
  // Clean up any existing directory
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true });
  }
  mkdirSync(outputDir, { recursive: true });

  // Concatenate audio files into a single bundle audio file
  const audioOutputPath = join(outputDir, meta.audioFile);
  const concatResult = await concatenateAudio(audioFiles, container, audioOutputPath, audioFormat);

  // Apply audio offsets to spans (modifies in place)
  applyAudioOffsets(spans, concatResult.offsets);

  // Write meta.json
  await writeMetaJson(outputDir, meta);

  // Write toc.json
  await writeTocJson(outputDir, toc);

  // Write spans.jsonl (with updated timestamps)
  await writeSpansJsonl(outputDir, spans, spanToPageIndex);

  // Write styles + pages
  await writeStylesAndPages(outputDir, pages);

  console.log(`Bundle written to: ${outputDir}`);
}

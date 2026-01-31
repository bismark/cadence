import { createWriteStream, mkdirSync, rmSync, existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import archiver from 'archiver';
import type {
  BundleMeta,
  Page,
  Span,
  SpanEntry,
  TocEntry,
  EPUBContainer,
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
  container: EPUBContainer
): Promise<void> {
  // Create a temporary directory for bundle contents
  const tempDir = outputPath.replace(/\.zip$/, '_temp');

  try {
    // Clean up any existing temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
    mkdirSync(tempDir, { recursive: true });

    // Build audio path map to handle filename collisions
    const audioPathMap = buildAudioPathMap(audioFiles);

    // Write meta.json
    await writeMetaJson(tempDir, meta);

    // Write toc.json
    await writeTocJson(tempDir, toc);

    // Write spans.jsonl
    await writeSpansJsonl(tempDir, spans, spanToPageIndex, audioPathMap);

    // Write pages
    await writePages(tempDir, pages);

    // Copy audio files
    await copyAudioFiles(tempDir, audioFiles, container, audioPathMap);

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
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Build a mapping from original audio paths to deduplicated output filenames.
 * Handles collisions by appending _1, _2, etc.
 */
function buildAudioPathMap(audioFiles: string[]): Map<string, string> {
  const pathMap = new Map<string, string>();
  const usedNames = new Map<string, number>();

  for (const audioPath of audioFiles) {
    const base = basename(audioPath);
    const ext = base.includes('.') ? base.substring(base.lastIndexOf('.')) : '';
    const name = base.includes('.') ? base.substring(0, base.lastIndexOf('.')) : base;

    const count = usedNames.get(base) || 0;
    usedNames.set(base, count + 1);

    const outputName = count === 0 ? base : `${name}_${count}${ext}`;
    pathMap.set(audioPath, outputName);
  }

  return pathMap;
}

/**
 * Write toc.json file
 */
async function writeTocJson(dir: string, toc: TocEntry[]): Promise<void> {
  const tocPath = join(dir, 'toc.json');
  await writeFile(tocPath, JSON.stringify(toc, null, 2));
}

/**
 * Write spans.jsonl file (one JSON object per line)
 */
async function writeSpansJsonl(
  dir: string,
  spans: Span[],
  spanToPageIndex: Map<string, number>,
  audioPathMap: Map<string, string>
): Promise<void> {
  const spansPath = join(dir, 'spans.jsonl');
  const lines: string[] = [];

  for (const span of spans) {
    const audioFilename = audioPathMap.get(span.audioSrc) || basename(span.audioSrc);
    const entry: SpanEntry = {
      id: span.id,
      audioSrc: `audio/${audioFilename}`,
      clipBeginMs: span.clipBeginMs,
      clipEndMs: span.clipEndMs,
      pageIndex: spanToPageIndex.get(span.id) ?? -1,
    };
    lines.push(JSON.stringify(entry));
  }

  await writeFile(spansPath, lines.join('\n'));
}

/**
 * Write page JSON files
 */
async function writePages(dir: string, pages: Page[]): Promise<void> {
  const pagesDir = join(dir, 'pages');
  await mkdir(pagesDir, { recursive: true });

  for (const page of pages) {
    const pagePath = join(pagesDir, `${page.pageId}.json`);
    await writeFile(pagePath, JSON.stringify(page, null, 2));
  }
}

/**
 * Copy audio files from EPUB to bundle
 */
async function copyAudioFiles(
  dir: string,
  audioFiles: string[],
  container: EPUBContainer,
  audioPathMap: Map<string, string>
): Promise<void> {
  const audioDir = join(dir, 'audio');
  await mkdir(audioDir, { recursive: true });

  for (const audioPath of audioFiles) {
    try {
      const audioData = await container.readFile(audioPath);
      const outputName = audioPathMap.get(audioPath) || basename(audioPath);
      const destPath = join(audioDir, outputName);
      await writeFile(destPath, audioData);
    } catch (err) {
      console.warn(`Warning: Could not copy audio file ${audioPath}: ${err}`);
    }
  }
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
  container: EPUBContainer
): Promise<void> {
  // Clean up any existing directory
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true });
  }
  mkdirSync(outputDir, { recursive: true });

  // Build audio path map to handle filename collisions
  const audioPathMap = buildAudioPathMap(audioFiles);

  // Write meta.json
  await writeMetaJson(outputDir, meta);

  // Write toc.json
  await writeTocJson(outputDir, toc);

  // Write spans.jsonl
  await writeSpansJsonl(outputDir, spans, spanToPageIndex, audioPathMap);

  // Write pages
  await writePages(outputDir, pages);

  // Copy audio files
  await copyAudioFiles(outputDir, audioFiles, container, audioPathMap);

  console.log(`Bundle written to: ${outputDir}`);
}

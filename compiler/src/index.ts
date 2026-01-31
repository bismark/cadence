#!/usr/bin/env node

import { Command } from 'commander';
import { resolve, basename } from 'node:path';
import { openEPUB } from './epub/container.js';
import { parseOPF, getSpineXHTMLFiles, getAudioFiles } from './epub/opf.js';
import { parseChapterSMIL } from './epub/smil.js';
import { normalizeXHTML } from './epub/xhtml.js';
import {
  initBrowser,
  closeBrowser,
  paginateChapters,
  assignSpansToPages,
} from './layout/paginate.js';
import { writeBundle, writeBundleUncompressed } from './bundle/writer.js';
import { getProfile, profiles } from './device-profiles/profiles.js';
import { validateCompilationResult, logValidationResult } from './validation.js';
import { previewAtTimestamp } from './preview.js';
import type { Span, NormalizedContent, BundleMeta, TocEntry, DeviceProfile } from './types.js';

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
  .action(async (options) => {
    try {
      const profile = getProfile(options.profile);
      await compileEPUB(options.input, options.output, options.zip, profile);
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

program.parse();

/**
 * Main compilation pipeline
 */
async function compileEPUB(
  inputPath: string,
  outputPath: string | undefined,
  createZip: boolean,
  profile: DeviceProfile
): Promise<void> {
  const resolvedInput = resolve(inputPath);
  const defaultOutput = resolvedInput.replace(/\.epub$/i, '.bundle.zip');
  const resolvedOutput = outputPath ? resolve(outputPath) : defaultOutput;

  console.log('Cadence Compiler v0.1.0');
  console.log('========================');
  console.log(`Input:  ${resolvedInput}`);
  console.log(`Output: ${resolvedOutput}`);
  console.log(`Profile: ${profile.name}`);
  console.log('');

  // Step 1: Open EPUB
  console.log('Step 1: Opening EPUB...');
  const container = await openEPUB(resolvedInput);

  try {
    // Step 2: Parse OPF
    console.log('Step 2: Parsing OPF...');
    const opf = await parseOPF(container);
    console.log(`  Title: ${opf.title}`);

    // Get spine files with media overlays
    const spineFiles = getSpineXHTMLFiles(opf);
    console.log(`  Spine items: ${spineFiles.length}`);

    const chaptersWithSMIL = spineFiles.filter((f) => f.smilHref);
    console.log(`  Chapters with media overlays: ${chaptersWithSMIL.length}`);

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

    for (const chapter of chaptersWithSMIL) {
      console.log(`  Normalizing: ${chapter.href}`);
      const content = await normalizeXHTML(
        container,
        chapter.href,
        chapter.id,
        allSpans,
        profile
      );
      normalizedContents.push(content);
    }

    // Step 5: Paginate with Playwright
    console.log('Step 5: Paginating content...');
    await initBrowser();

    const pages = await paginateChapters(normalizedContents, profile);
    console.log(`  Total pages: ${pages.length}`);

    // Step 6: Assign spans to pages and build ToC
    console.log('Step 6: Mapping spans to pages...');
    const spanToPageIndex = assignSpansToPages(pages);
    console.log(`  Mapped ${spanToPageIndex.size} spans to pages`);

    // Build table of contents (chapter title -> starting page index)
    const toc: TocEntry[] = [];
    for (const chapter of chaptersWithSMIL) {
      const firstPage = pages.find((p) => p.chapterId === chapter.id);
      if (firstPage) {
        toc.push({
          title: chapter.id, // TODO: extract actual chapter title from XHTML
          pageIndex: firstPage.pageIndex,
        });
      }
    }
    console.log(`  ToC entries: ${toc.length}`);

    // Step 7: Collect audio files
    console.log('Step 7: Collecting audio files...');
    const audioFiles = getAudioFiles(opf);
    console.log(`  Audio files: ${audioFiles.length}`);

    // Step 8: Write bundle
    console.log('Step 8: Writing bundle...');

    const meta: BundleMeta = {
      bundleVersion: '1.0.0',
      profile: profile.name,
      title: opf.title,
      pages: pages.length,
      spans: allSpans.length,
    };

    if (createZip) {
      await writeBundle(
        resolvedOutput,
        meta,
        allSpans,
        pages,
        spanToPageIndex,
        toc,
        audioFiles,
        container
      );
    } else {
      const uncompressedDir = resolvedOutput.replace(/\.zip$/, '');
      await writeBundleUncompressed(
        uncompressedDir,
        meta,
        allSpans,
        pages,
        spanToPageIndex,
        toc,
        audioFiles,
        container
      );
    }

    // Step 9: Validate output
    console.log('Step 9: Validating output...');
    const validationResult = validateCompilationResult(allSpans, pages, spanToPageIndex, profile);
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

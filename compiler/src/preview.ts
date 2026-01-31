/**
 * Preview renderer - generates PNG images from compiled bundles
 */

import { chromium } from 'playwright';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, SpanEntry, BundleMeta, DeviceProfile } from './types.js';
import { getProfile } from './device-profiles/profiles.js';

interface BundleData {
  meta: BundleMeta;
  spans: SpanEntry[];
  pages: Page[];  // Ordered by pageIndex
}

/**
 * Load a compiled bundle from disk
 */
export async function loadBundle(bundlePath: string): Promise<BundleData> {
  // Load metadata
  const metaJson = await readFile(join(bundlePath, 'meta.json'), 'utf-8');
  const meta: BundleMeta = JSON.parse(metaJson);

  // Load spans
  const spansJsonl = await readFile(join(bundlePath, 'spans.jsonl'), 'utf-8');
  const spans: SpanEntry[] = spansJsonl
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  // Load all pages
  const pagesDir = join(bundlePath, 'pages');
  const pageFiles = await readdir(pagesDir);
  const pages: Page[] = [];

  for (const file of pageFiles) {
    if (file.endsWith('.json')) {
      const pageJson = await readFile(join(pagesDir, file), 'utf-8');
      const page: Page = JSON.parse(pageJson);
      pages.push(page);
    }
  }

  // Sort by pageIndex
  pages.sort((a, b) => a.pageIndex - b.pageIndex);

  return { meta, spans, pages };
}

/**
 * Find the active span at a given timestamp
 */
export function findSpanAtTime(spans: SpanEntry[], timestampMs: number): SpanEntry | null {
  for (const span of spans) {
    if (timestampMs >= span.clipBeginMs && timestampMs < span.clipEndMs) {
      return span;
    }
  }
  return null;
}

/**
 * Generate HTML to render a page with text runs
 */
function generatePageHTML(page: Page, profile: DeviceProfile, activeSpanId?: string): string {
  const { margins, viewportWidth, viewportHeight } = profile;

  const textRunsHtml = page.textRuns
    .map((run) => {
      const isActive = run.spanId === activeSpanId;
      const bgColor = isActive ? 'rgba(255, 200, 0, 0.4)' : 'transparent';
      const styles = [
        `position: absolute`,
        `left: ${run.x}px`,
        `top: ${run.y}px`,
        `width: ${run.width}px`,
        `height: ${run.height}px`,
        `font-family: ${run.style.fontFamily}`,
        `font-size: ${run.style.fontSize}px`,
        `font-weight: ${run.style.fontWeight}`,
        `font-style: ${run.style.fontStyle}`,
        `color: ${run.style.color}`,
        `background: ${bgColor}`,
        `line-height: ${run.height}px`,
        `overflow: hidden`,
        `white-space: nowrap`,
      ].join('; ');

      const escapedText = run.text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      return `<div style="${styles}">${escapedText}</div>`;
    })
    .join('\n');

  // Draw span rect outlines for debugging
  const spanRectsHtml = page.spanRects
    .map((sr) => {
      const isActive = sr.spanId === activeSpanId;
      const borderColor = isActive ? 'rgba(255, 150, 0, 0.8)' : 'rgba(100, 100, 255, 0.3)';
      const borderWidth = isActive ? '3px' : '1px';

      return sr.rects
        .map((rect) => {
          const styles = [
            `position: absolute`,
            `left: ${rect.x}px`,
            `top: ${rect.y}px`,
            `width: ${rect.width}px`,
            `height: ${rect.height}px`,
            `border: ${borderWidth} solid ${borderColor}`,
            `box-sizing: border-box`,
            `pointer-events: none`,
          ].join('; ');
          return `<div style="${styles}"></div>`;
        })
        .join('\n');
    })
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${viewportWidth}px;
      height: ${viewportHeight}px;
      background: #e8e8e8;
      overflow: hidden;
    }
    .content-area {
      position: absolute;
      left: ${margins.left}px;
      top: ${margins.top}px;
      width: ${page.width}px;
      height: ${page.height}px;
      background: #ffffff;
    }
  </style>
</head>
<body>
  <div class="content-area">
    ${textRunsHtml}
    ${spanRectsHtml}
  </div>
</body>
</html>`;
}

/**
 * Render a page to a PNG image
 */
export async function renderPageToPNG(
  page: Page,
  profile: DeviceProfile,
  outputPath: string,
  activeSpanId?: string
): Promise<void> {
  const browser = await chromium.launch({ headless: true });

  try {
    const browserPage = await browser.newPage();

    await browserPage.setViewportSize({
      width: profile.viewportWidth,
      height: profile.viewportHeight,
    });

    const html = generatePageHTML(page, profile, activeSpanId);
    await browserPage.setContent(html, { waitUntil: 'domcontentloaded' });

    await browserPage.screenshot({
      path: outputPath,
      type: 'png',
    });
  } finally {
    await browser.close();
  }
}

/**
 * Preview a bundle at a specific timestamp
 */
export async function previewAtTimestamp(
  bundlePath: string,
  timestampMs: number,
  outputPath: string
): Promise<{ pageIndex: number; spanId: string | null; timestampMs: number }> {
  const bundle = await loadBundle(bundlePath);

  // Load the device profile
  const profile = getProfile(bundle.meta.profile);

  // Find the active span
  const activeSpan = findSpanAtTime(bundle.spans, timestampMs);

  if (!activeSpan) {
    throw new Error(`No span found at timestamp ${timestampMs}ms`);
  }

  // Get the page for this span
  const page = bundle.pages[activeSpan.pageIndex];

  if (!page) {
    throw new Error(`Page at index ${activeSpan.pageIndex} not found in bundle`);
  }

  // Render the page
  await renderPageToPNG(page, profile, outputPath, activeSpan.id);

  return {
    pageIndex: activeSpan.pageIndex,
    spanId: activeSpan.id,
    timestampMs,
  };
}

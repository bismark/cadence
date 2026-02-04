import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page as PlaywrightPage } from 'playwright';
import { getContentArea } from '../device-profiles/profiles.js';
import type { DeviceProfile, NormalizedContent, Page, PageSpanRect, TextRun } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FONTS_DIR = join(__dirname, '../../fonts');

let browser: Browser | null = null;

/**
 * Load font file and convert to base64 data URI
 */
function loadFontAsDataUri(filename: string): string {
  const fontPath = join(FONTS_DIR, filename);
  const fontData = readFileSync(fontPath);
  const base64 = fontData.toString('base64');
  return `data:font/ttf;base64,${base64}`;
}

/**
 * Generate font face CSS with embedded base64 fonts
 * Cached after first call since fonts don't change
 */
let fontFaceCSSCache: string | null = null;
function getFontFaceCSS(): string {
  if (fontFaceCSSCache) return fontFaceCSSCache;

  const regular = loadFontAsDataUri('NotoSerif-Regular.ttf');
  const bold = loadFontAsDataUri('NotoSerif-Bold.ttf');
  const italic = loadFontAsDataUri('NotoSerif-Italic.ttf');
  const boldItalic = loadFontAsDataUri('NotoSerif-BoldItalic.ttf');

  fontFaceCSSCache = `
@font-face {
  font-family: 'Noto Serif';
  font-style: normal;
  font-weight: 400;
  src: url('${regular}') format('truetype');
}
@font-face {
  font-family: 'Noto Serif';
  font-style: normal;
  font-weight: 700;
  src: url('${bold}') format('truetype');
}
@font-face {
  font-family: 'Noto Serif';
  font-style: italic;
  font-weight: 400;
  src: url('${italic}') format('truetype');
}
@font-face {
  font-family: 'Noto Serif';
  font-style: italic;
  font-weight: 700;
  src: url('${boldItalic}') format('truetype');
}
`;
  return fontFaceCSSCache;
}

/**
 * Initialize the Playwright browser
 */
export async function initBrowser(): Promise<void> {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
    });
  }
}

/**
 * Close the Playwright browser
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Paginate normalized HTML content using CSS multi-column layout
 * Browser handles proper page breaks - no splitting text across pages
 */
export async function paginateContent(
  content: NormalizedContent,
  profile: DeviceProfile,
): Promise<Page[]> {
  if (!browser) {
    await initBrowser();
  }

  // Browser is guaranteed to be initialized at this point
  const page = await browser!.newPage();

  try {
    const contentArea = getContentArea(profile);
    const columnWidth = contentArea.width;
    const columnHeight = contentArea.height;
    const columnGap = profile.margins.left + profile.margins.right;

    // Set viewport wide enough for many columns (we'll count them)
    await page.setViewportSize({
      width: profile.viewportWidth * 50, // Wide enough for ~50 pages
      height: profile.viewportHeight,
    });

    // Inject font-face CSS and column layout CSS
    const fontFaceCSS = getFontFaceCSS();
    const columnCSS = `
      .cadence-content {
        column-width: ${columnWidth}px;
        column-gap: ${columnGap}px;
        column-fill: auto;
        height: ${columnHeight}px;
        overflow: visible;
      }
      /* Prevent breaks inside paragraphs and spans */
      p, [data-span-id] {
        break-inside: avoid;
        orphans: 2;
        widows: 2;
      }
    `;

    const htmlWithColumns = content.html.replace('<style>', `<style>${fontFaceCSS}${columnCSS}`);

    await page.setContent(htmlWithColumns, {
      waitUntil: 'domcontentloaded',
    });

    await page.evaluate(() => document.fonts.ready);

    // Count how many columns were created
    const columnCount = await page.evaluate(
      ({ columnWidth, columnGap }) => {
        const el = document.querySelector('.cadence-content') as HTMLElement;
        if (!el) return 1;
        // Total width divided by (column width + gap) gives column count
        return Math.ceil(el.scrollWidth / (columnWidth + columnGap));
      },
      { columnWidth, columnGap },
    );

    console.log(`      Using CSS columns: ${columnCount} pages`);

    const totalColumnWidth = Math.ceil(columnCount * (columnWidth + columnGap));
    const viewport = page.viewportSize();
    if (viewport && totalColumnWidth > viewport.width) {
      await page.setViewportSize({
        width: totalColumnWidth,
        height: profile.viewportHeight,
      });
    }

    // Extract content for each column/page
    const pages: Page[] = [];

    for (let colIndex = 0; colIndex < columnCount; colIndex++) {
      const colLeft = colIndex * (columnWidth + columnGap);

      const pageData = await page.evaluate(
        ({ colIndex, colLeft, columnWidth, columnHeight, marginTop, marginLeft }) => {
          const textRuns: Array<{
            text: string;
            x: number;
            y: number;
            width: number;
            height: number;
            spanId?: string;
            style: {
              fontFamily: string;
              fontSize: number;
              fontWeight: number;
              fontStyle: 'normal' | 'italic';
              color: string;
            };
          }> = [];

          const spanRects: Array<{
            spanId: string;
            rects: Array<{ x: number; y: number; width: number; height: number }>;
          }> = [];

          // Helper functions
          function isInColumn(rect: DOMRect): boolean {
            const rectMidX = rect.left + rect.width / 2;
            return (
              rectMidX >= colLeft + marginLeft && rectMidX < colLeft + marginLeft + columnWidth
            );
          }

          function toPageCoords(rect: DOMRect): {
            x: number;
            y: number;
            width: number;
            height: number;
          } {
            return {
              x: Math.round(rect.left - colLeft - marginLeft),
              y: Math.round(rect.top - marginTop),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          }

          // Extract span rects in this column
          const spanElements = Array.from(document.querySelectorAll('[data-span-id]'));
          for (const el of spanElements) {
            const spanId = el.getAttribute('data-span-id');
            if (!spanId) continue;

            // Use Range to get tight text rects (not block element width)
            const range = document.createRange();
            range.selectNodeContents(el);
            const clientRects = range.getClientRects();
            const rects: Array<{ x: number; y: number; width: number; height: number }> = [];

            for (let i = 0; i < clientRects.length; i++) {
              const rect = clientRects[i];
              if (rect.width === 0 || rect.height === 0) continue;
              if (isInColumn(rect)) {
                rects.push(toPageCoords(rect));
              }
            }

            if (rects.length > 0) {
              spanRects.push({ spanId, rects });
            }
          }

          // Extract text runs in this column
          const walker = document.createTreeWalker(
            document.querySelector('.cadence-content') || document.body,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode: (node) =>
                node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
            },
          );

          let textNode: Text | null;
          while ((textNode = walker.nextNode() as Text | null)) {
            const parent = textNode.parentElement;
            if (!parent) continue;

            const spanElement = parent.closest('[data-span-id]');
            const spanId = spanElement?.getAttribute('data-span-id') || undefined;

            const computedStyle = window.getComputedStyle(parent);
            const style = {
              fontFamily: computedStyle.fontFamily,
              fontSize: parseFloat(computedStyle.fontSize),
              fontWeight: parseInt(computedStyle.fontWeight, 10) || 400,
              fontStyle: (computedStyle.fontStyle === 'italic' ? 'italic' : 'normal') as
                | 'normal'
                | 'italic',
              color: computedStyle.color,
            };

            const nodeRange = document.createRange();
            nodeRange.selectNodeContents(textNode);
            const rects = nodeRange.getClientRects();

            for (let i = 0; i < rects.length; i++) {
              const rect = rects[i];
              if (rect.width === 0 || rect.height === 0) continue;
              if (!isInColumn(rect)) continue;

              const pageCoords = toPageCoords(rect);

              // Get text for this rect using caret probing
              const midY = rect.top + rect.height / 2;
              let lineText = '';

              if (document.caretRangeFromPoint) {
                const startRange = document.caretRangeFromPoint(rect.left + 1, midY);
                const endRange = document.caretRangeFromPoint(rect.right - 1, midY);

                if (startRange && endRange) {
                  try {
                    const lineRange = document.createRange();
                    lineRange.setStart(startRange.startContainer, startRange.startOffset);
                    lineRange.setEnd(endRange.startContainer, endRange.startOffset);
                    lineText = lineRange.toString().replace(/\s+/g, ' ');
                  } catch {}
                }
              }

              if (lineText) {
                textRuns.push({
                  text: lineText,
                  ...pageCoords,
                  spanId,
                  style,
                });
              }
            }
          }

          // Dedupe text runs by position
          const seen = new Set<string>();
          const dedupedRuns = textRuns.filter((run) => {
            const key = `${run.x},${run.y},${run.text}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          return { textRuns: dedupedRuns, spanRects };
        },
        {
          colIndex,
          colLeft,
          columnWidth,
          columnHeight,
          marginTop: profile.margins.top,
          marginLeft: profile.margins.left,
        },
      );

      // Build page
      const visibleSpanIds = pageData.spanRects.map((sr) => sr.spanId);

      pages.push({
        pageId: `${content.chapterId}_p${String(colIndex + 1).padStart(4, '0')}`,
        chapterId: content.chapterId,
        pageIndex: colIndex,
        width: columnWidth,
        height: columnHeight,
        textRuns: pageData.textRuns,
        spanRects: pageData.spanRects,
        firstSpanId: visibleSpanIds[0] || '',
        lastSpanId: visibleSpanIds[visibleSpanIds.length - 1] || '',
      });
    }

    return pages;
  } finally {
    await page.close();
  }
}

/**
 * Extract rectangles for all spans visible on the current page view
 * Returns page-local coordinates (relative to content area, not viewport)
 */
async function _extractSpanRects(
  page: PlaywrightPage,
  pageHeight: number,
  marginTop: number,
  marginLeft: number,
  actualScrollTop: number,
  pageContentStart: number,
  pageContentEnd: number,
): Promise<PageSpanRect[]> {
  const result = await page.evaluate(
    ({ pageHeight, marginTop, marginLeft, actualScrollTop, pageContentStart, pageContentEnd }) => {
      const spanRects: Array<{
        spanId: string;
        rects: Array<{ x: number; y: number; width: number; height: number }>;
      }> = [];
      const elements = Array.from(document.querySelectorAll('[data-span-id]'));

      for (const el of elements) {
        const spanId = el.getAttribute('data-span-id');
        if (!spanId) continue;

        // Use Range to get tight text rects (not block element width)
        const range = document.createRange();
        range.selectNodeContents(el);
        const clientRects = range.getClientRects();
        const rects: Array<{ x: number; y: number; width: number; height: number }> = [];

        for (let i = 0; i < clientRects.length; i++) {
          const rect = clientRects[i];

          // Convert viewport coordinates to page-local coordinates
          const pageLocalX = rect.left - marginLeft;
          const pageLocalY = rect.top - marginTop;

          // Include content if its TOP is on or below the top of the viewport (y >= 0)
          // Skip content whose top is above viewport (already shown on previous page)
          // No upper bound - content may extend past page bottom, player will clip
          if (pageLocalY >= 0) {
            rects.push({
              x: Math.round(pageLocalX),
              y: Math.round(pageLocalY),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            });
          }
        }

        if (rects.length > 0) {
          spanRects.push({ spanId, rects });
        }
      }

      return spanRects;
    },
    { pageHeight, marginTop, marginLeft, actualScrollTop, pageContentStart, pageContentEnd },
  );

  return result;
}

/**
 * Extract positioned text runs visible on the current page view
 * Uses caret probing to accurately extract text per visual line
 */
async function _extractTextRuns(
  page: PlaywrightPage,
  pageHeight: number,
  marginTop: number,
  marginLeft: number,
  actualScrollTop: number,
  pageContentStart: number,
  pageContentEnd: number,
): Promise<TextRun[]> {
  const result = await page.evaluate(
    ({ pageHeight, marginTop, marginLeft, actualScrollTop, pageContentStart, pageContentEnd }) => {
      const textRuns: Array<{
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
        spanId?: string;
        style: {
          fontFamily: string;
          fontSize: number;
          fontWeight: number;
          fontStyle: 'normal' | 'italic';
          color: string;
        };
      }> = [];

      /**
       * Get caret position from point, with fallback
       */
      function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
        // Chrome/modern browsers
        if (document.caretRangeFromPoint) {
          const range = document.caretRangeFromPoint(x, y);
          if (range) {
            return { node: range.startContainer, offset: range.startOffset };
          }
        }
        return null;
      }

      /**
       * Check if a caret position is within a range
       */
      function isCaretInRange(caret: { node: Node; offset: number }, range: Range): boolean {
        try {
          return range.isPointInRange(caret.node, caret.offset);
        } catch {
          return false;
        }
      }

      /**
       * Extract line text using caret probing
       */
      function extractLineText(rect: DOMRect, sourceRange: Range): string {
        const midY = rect.top + rect.height / 2;

        // Probe start and end of line with small insets
        const startCaret = caretFromPoint(rect.left + 1, midY);
        const endCaret = caretFromPoint(rect.right - 1, midY);

        if (!startCaret || !endCaret) {
          return '';
        }

        // Clamp carets to source range
        const clampedStart = isCaretInRange(startCaret, sourceRange)
          ? startCaret
          : {
              node: sourceRange.startContainer,
              offset: sourceRange.startOffset,
            };
        const clampedEnd = isCaretInRange(endCaret, sourceRange)
          ? endCaret
          : {
              node: sourceRange.endContainer,
              offset: sourceRange.endOffset,
            };

        // Create sub-range for this line
        try {
          const lineRange = document.createRange();
          lineRange.setStart(clampedStart.node, clampedStart.offset);
          lineRange.setEnd(clampedEnd.node, clampedEnd.offset);
          return lineRange.toString();
        } catch {
          return '';
        }
      }

      /**
       * Group rects by visual line (same Y within tolerance)
       */
      function groupRectsByLine(rects: DOMRectList): DOMRect[][] {
        const lines: DOMRect[][] = [];
        const tolerance = 2; // pixels

        for (let i = 0; i < rects.length; i++) {
          const rect = rects[i];
          if (rect.width === 0 || rect.height === 0) continue;

          // Find existing line with similar Y
          let foundLine = false;
          for (const line of lines) {
            if (Math.abs(line[0].top - rect.top) < tolerance) {
              line.push(rect);
              foundLine = true;
              break;
            }
          }

          if (!foundLine) {
            lines.push([rect]);
          }
        }

        // Sort lines by Y position
        lines.sort((a, b) => a[0].top - b[0].top);

        return lines;
      }

      /**
       * Merge rects on the same line into one bounding rect
       */
      function mergeLineRects(rects: DOMRect[]): DOMRect {
        const left = Math.min(...rects.map((r) => r.left));
        const right = Math.max(...rects.map((r) => r.right));
        const top = Math.min(...rects.map((r) => r.top));
        const bottom = Math.max(...rects.map((r) => r.bottom));

        return new DOMRect(left, top, right - left, bottom - top);
      }

      // Walk the DOM to find all text nodes
      const walker = document.createTreeWalker(
        document.querySelector('.cadence-content') || document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const text = node.textContent?.trim();
            if (!text) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );

      let textNode: Text | null;
      while ((textNode = walker.nextNode() as Text | null)) {
        const parent = textNode.parentElement;
        if (!parent) continue;

        // Check if this text is inside a span element
        const spanElement = parent.closest('[data-span-id]');
        const spanId = spanElement?.getAttribute('data-span-id') || undefined;

        // Get computed style
        const computedStyle = window.getComputedStyle(parent);
        const style = {
          fontFamily: computedStyle.fontFamily,
          fontSize: parseFloat(computedStyle.fontSize),
          fontWeight: parseInt(computedStyle.fontWeight, 10) || 400,
          fontStyle: (computedStyle.fontStyle === 'italic' ? 'italic' : 'normal') as
            | 'normal'
            | 'italic',
          color: computedStyle.color,
        };

        // Create range for this text node
        const nodeRange = document.createRange();
        nodeRange.selectNodeContents(textNode);
        const rects = nodeRange.getClientRects();

        // Group rects by visual line
        const lines = groupRectsByLine(rects);

        for (const lineRects of lines) {
          // Merge rects on the same line
          const lineRect = mergeLineRects(lineRects);

          // Convert to page-local coordinates
          const pageLocalX = lineRect.left - marginLeft;
          const pageLocalY = lineRect.top - marginTop;

          // Include content if its TOP is on or below the top of the viewport (y >= 0)
          // Skip content whose top is above viewport (already shown on previous page)
          // No upper bound - content may extend past page bottom, player will clip
          if (pageLocalY >= 0) {
            // Extract the actual text for this line using caret probing
            const lineText = extractLineText(lineRect, nodeRange);

            if (lineText) {
              // Normalize whitespace (collapse \n\t\s sequences to single space)
              const normalizedText = lineText.replace(/\s+/g, ' ');
              textRuns.push({
                text: normalizedText,
                x: Math.round(pageLocalX),
                y: Math.round(pageLocalY),
                width: Math.round(lineRect.width),
                height: Math.round(lineRect.height),
                spanId,
                style,
              });
            }
          }
        }
      }

      return textRuns;
    },
    { pageHeight, marginTop, marginLeft, actualScrollTop, pageContentStart, pageContentEnd },
  );

  return result;
}

/**
 * Paginate multiple chapters and return all pages with global indices
 */
export async function paginateChapters(
  contents: NormalizedContent[],
  profile: DeviceProfile,
): Promise<Page[]> {
  const allPages: Page[] = [];
  let globalPageIndex = 0;

  for (const content of contents) {
    console.log(`  Paginating chapter: ${content.chapterId}`);
    const pages = await paginateContent(content, profile);

    // Assign global page indices
    for (const page of pages) {
      page.pageIndex = globalPageIndex;
      globalPageIndex++;
    }

    allPages.push(...pages);
    console.log(`    Generated ${pages.length} pages`);
  }

  return allPages;
}

/**
 * Map span IDs to their global page indices
 */
export function assignSpansToPages(pages: Page[]): Map<string, number> {
  const spanToPageIndex = new Map<string, number>();

  for (const page of pages) {
    for (const spanRect of page.spanRects) {
      // If a span appears on multiple pages, use the first occurrence
      if (!spanToPageIndex.has(spanRect.spanId)) {
        spanToPageIndex.set(spanRect.spanId, page.pageIndex);
      }
    }
  }

  return spanToPageIndex;
}

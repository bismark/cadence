import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page as PlaywrightPage, type Route } from 'playwright';
import { didSanitizeCss, sanitizeCssForPagination } from '../css/sanitization.js';
import { getContentArea } from '../device-profiles/profiles.js';
import type { DeviceProfile, EPUBContainer, NormalizedContent, Page } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FONTS_DIR = join(__dirname, '../../fonts');

let browser: Browser | null = null;

const EPUB_VIRTUAL_ORIGIN = 'https://epub.local';
const EINK_GRAY_LEVELS = 4;
const CRITICAL_PAGINATION_RESOURCE_EXTENSIONS = new Set([
  '.css',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
]);

export interface PaginationRoutingDiagnostics {
  fatalIssues: string[];
  warningIssues: string[];
}

interface RouteLike {
  request(): {
    url(): string;
    headers(): Record<string, string>;
    resourceType(): string;
  };
  fulfill(options: { status: number; contentType: string; body: string | Buffer }): Promise<void>;
  continue(): Promise<void>;
}

export function createPaginationRoutingDiagnostics(): PaginationRoutingDiagnostics {
  return {
    fatalIssues: [],
    warningIssues: [],
  };
}

export function classifyPaginationRequestUrl(
  requestUrl: string,
):
  | { kind: 'epub-resource'; path: string }
  | { kind: 'inline-resource' }
  | { kind: 'blocked'; reason: string } {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestUrl);
  } catch {
    return { kind: 'blocked', reason: 'invalid URL' };
  }

  if (parsedUrl.protocol === 'data:' || parsedUrl.protocol === 'blob:') {
    return { kind: 'inline-resource' };
  }

  if (parsedUrl.origin !== EPUB_VIRTUAL_ORIGIN) {
    return {
      kind: 'blocked',
      reason: `origin ${parsedUrl.origin} is not allowed`,
    };
  }

  const decodedPath = decodeVirtualUrlPath(parsedUrl.pathname);
  if (decodedPath === null) {
    return { kind: 'blocked', reason: 'invalid EPUB resource path' };
  }

  return {
    kind: 'epub-resource',
    path: decodedPath,
  };
}

export function isCriticalPaginationResource(requestPath: string, resourceType: string): boolean {
  const normalizedResourceType = resourceType.trim().toLowerCase();
  if (normalizedResourceType === 'stylesheet' || normalizedResourceType === 'font') {
    return true;
  }

  const extension = posix.extname(requestPath).toLowerCase();
  return CRITICAL_PAGINATION_RESOURCE_EXTENSIONS.has(extension);
}

function normalizeEpubPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function encodeEpubPathForUrl(path: string): string {
  const normalized = normalizeEpubPath(path);
  if (!normalized) {
    return '';
  }

  return normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function decodeVirtualUrlPath(pathname: string): string | null {
  const rawPath = pathname.replace(/^\/+/, '');
  if (!rawPath) {
    return '';
  }

  let decodedPath = '';
  try {
    decodedPath = rawPath
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return null;
  }

  const normalized = posix.normalize(decodedPath);
  if (normalized === '..' || normalized.startsWith('../')) {
    return null;
  }

  if (normalized === '.' || normalized === '/') {
    return '';
  }

  return normalizeEpubPath(normalized);
}

function getChapterBaseHref(xhtmlPath: string): string {
  const normalizedPath = normalizeEpubPath(xhtmlPath);
  const slashIndex = normalizedPath.lastIndexOf('/');
  const directoryPath = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex + 1) : '';
  const encodedDirectoryPath = encodeEpubPathForUrl(directoryPath);

  if (!encodedDirectoryPath) {
    return `${EPUB_VIRTUAL_ORIGIN}/`;
  }

  return `${EPUB_VIRTUAL_ORIGIN}/${encodedDirectoryPath}`;
}

function injectBaseHref(html: string, baseHref: string): string {
  if (/<base\s/i.test(html)) {
    return html;
  }

  return html.replace(/<head([^>]*)>/i, `<head$1>\n  <base href="${baseHref}">`);
}

function getContentType(path: string): string {
  const extension = posix.extname(path).toLowerCase();

  switch (extension) {
    case '.xhtml':
    case '.xml':
    case '.opf':
      return 'application/xhtml+xml';
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.smil':
      return 'application/smil+xml';
    default:
      return 'application/octet-stream';
  }
}

function isStylesheetResource(
  requestPath: string,
  contentType: string,
  resourceType: string,
): boolean {
  if (resourceType.trim().toLowerCase() === 'stylesheet') {
    return true;
  }

  if (contentType.toLowerCase().startsWith('text/css')) {
    return true;
  }

  return posix.extname(requestPath).toLowerCase() === '.css';
}

function decodeVirtualUrlToPath(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    if (url.origin !== EPUB_VIRTUAL_ORIGIN) {
      return null;
    }
    return decodeVirtualUrlPath(url.pathname);
  } catch {
    return null;
  }
}

function getRequestSource(requestHeaders: Record<string, string>, fallbackPath: string): string {
  const referer = requestHeaders.referer ?? requestHeaders.Referer;
  if (!referer) {
    return fallbackPath;
  }

  const refererPath = decodeVirtualUrlToPath(referer);
  return refererPath ?? referer;
}

function addUniqueIssue(issues: string[], seen: Set<string>, message: string): void {
  if (seen.has(message)) {
    return;
  }

  seen.add(message);
  issues.push(message);
}

export function throwOnPaginationRoutingFailures(
  chapterId: string,
  diagnostics: PaginationRoutingDiagnostics,
): void {
  if (diagnostics.fatalIssues.length === 0) {
    return;
  }

  const details = diagnostics.fatalIssues.map((issue) => `  - ${issue}`).join('\n');
  throw new Error(`Pagination resource policy violations for chapter "${chapterId}":\n${details}`);
}

export function createEpubResourceRouteHandler(
  container: EPUBContainer,
  content: NormalizedContent,
  diagnostics: PaginationRoutingDiagnostics,
): (route: RouteLike) => Promise<void> {
  const seenFatalIssues = new Set<string>();
  const seenWarningIssues = new Set<string>();

  return async (route: RouteLike): Promise<void> => {
    const request = route.request();
    const requestUrl = request.url();
    const requestSource = getRequestSource(request.headers(), content.xhtmlPath);

    const classification = classifyPaginationRequestUrl(requestUrl);
    if (classification.kind === 'inline-resource') {
      await route.continue();
      return;
    }

    if (classification.kind === 'blocked') {
      const issue =
        `blocked non-EPUB request "${requestUrl}"` +
        ` (chapter=${content.chapterId}, source=${requestSource}, reason=${classification.reason})`;

      addUniqueIssue(diagnostics.fatalIssues, seenFatalIssues, issue);

      await route.fulfill({
        status: 403,
        contentType: 'text/plain; charset=utf-8',
        body: `Blocked non-EPUB request: ${requestUrl}`,
      });
      return;
    }

    const requestPath = classification.path;

    try {
      const resource = await container.readFile(requestPath);
      const contentType = getContentType(requestPath);

      let responseBody: string | Buffer = resource;
      if (isStylesheetResource(requestPath, contentType, request.resourceType())) {
        const rawCss = resource.toString('utf-8');
        const sanitization = sanitizeCssForPagination(rawCss);

        if (didSanitizeCss(sanitization.summary)) {
          const issue =
            `sanitized stylesheet "${requestPath}"` +
            ` (chapter=${content.chapterId}, source=${requestSource}, removedImports=${sanitization.summary.removedImportCount},` +
            ` rewrittenUrls=${sanitization.summary.rewrittenUrlCount}, removedDeclarations=${sanitization.summary.removedDeclarationCount})`;

          addUniqueIssue(diagnostics.warningIssues, seenWarningIssues, issue);
        }

        responseBody = sanitization.css;
      }

      await route.fulfill({
        status: 200,
        contentType,
        body: responseBody,
      });
    } catch {
      const critical = isCriticalPaginationResource(requestPath, request.resourceType());
      const issue =
        `missing EPUB resource "${requestPath}"` +
        ` (chapter=${content.chapterId}, source=${requestSource}, critical=${critical ? 'yes' : 'no'})`;

      if (critical) {
        addUniqueIssue(diagnostics.fatalIssues, seenFatalIssues, issue);
      } else {
        addUniqueIssue(diagnostics.warningIssues, seenWarningIssues, issue);
      }

      await route.fulfill({
        status: 404,
        contentType: 'text/plain; charset=utf-8',
        body: `Missing EPUB resource: ${requestPath}`,
      });
    }
  };
}

async function setupEpubResourceRouting(
  page: PlaywrightPage,
  container: EPUBContainer,
  content: NormalizedContent,
): Promise<PaginationRoutingDiagnostics> {
  const diagnostics = createPaginationRoutingDiagnostics();
  const routeHandler = createEpubResourceRouteHandler(container, content, diagnostics);

  // Security policy: deny-by-default and only fulfill requests from the EPUB virtual origin.
  await page.route('**/*', routeHandler as (route: Route) => Promise<void>);

  return diagnostics;
}

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
  container?: EPUBContainer,
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
      /* Prevent breaks inside spans; allow paragraph breaks */
      [data-span-id] {
        break-inside: avoid;
      }
      p {
        orphans: 2;
        widows: 2;
      }
    `;

    const chapterBaseHref = getChapterBaseHref(content.xhtmlPath);
    const htmlWithColumns = content.html.replace('<style>', `<style>${fontFaceCSS}${columnCSS}`);
    const htmlWithBase = injectBaseHref(htmlWithColumns, chapterBaseHref);

    const routingDiagnostics = container
      ? await setupEpubResourceRouting(page, container, content)
      : null;

    let loggedWarningIssueCount = 0;
    const logNewRoutingWarnings = (): void => {
      if (!routingDiagnostics) {
        return;
      }

      while (loggedWarningIssueCount < routingDiagnostics.warningIssues.length) {
        console.warn(`  Warning: ${routingDiagnostics.warningIssues[loggedWarningIssueCount]}`);
        loggedWarningIssueCount += 1;
      }
    };

    const assertNoFatalRoutingIssues = (): void => {
      if (!routingDiagnostics) {
        return;
      }

      throwOnPaginationRoutingFailures(content.chapterId, routingDiagnostics);
    };

    await page.setContent(htmlWithBase, {
      waitUntil: 'domcontentloaded',
    });

    await page.evaluate(() => document.fonts.ready);

    logNewRoutingWarnings();
    assertNoFatalRoutingIssues();

    // Rely on source-authored break hints (break-before/after, page-break-*)
    // instead of injecting heuristic chapter breaks.

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
      logNewRoutingWarnings();
      assertNoFatalRoutingIssues();

      const colLeft = colIndex * (columnWidth + columnGap);

      const pageData = await page.evaluate(
        ({ colLeft, columnWidth, marginTop, marginLeft, grayLevels }) => {
          const textRuns: Array<{
            text: string;
            x: number;
            y: number;
            width: number;
            height: number;
            baselineY: number;
            spanId?: string;
            style: {
              fontFamily: string;
              fontSize: number;
              fontWeight: number;
              fontStyle: 'normal' | 'italic';
              inkGray: number;
            };
          }> = [];

          const spanRects: Array<{
            spanId: string;
            rects: Array<{ x: number; y: number; width: number; height: number }>;
          }> = [];

          // Helper functions
          const columnLeft = colLeft + marginLeft;
          const columnRight = columnLeft + columnWidth;
          const columnLeftTolerancePx = 4;

          function isInColumn(rect: DOMRect): boolean {
            // Assign runs to a column by where the line box starts (not midpoint).
            // This avoids bleed-through from neighboring columns while still tolerating
            // slight left overhang (e.g., opening punctuation/italics).
            return rect.left >= columnLeft - columnLeftTolerancePx && rect.left < columnRight;
          }

          function toPageCoords(rect: DOMRect): {
            x: number;
            y: number;
            width: number;
            height: number;
          } {
            return {
              x: Math.max(0, rect.left - columnLeft),
              y: rect.top - marginTop,
              width: Math.max(0, rect.width),
              height: Math.max(0, rect.height),
            };
          }

          function toPageCoordsFromBounds(bounds: {
            left: number;
            top: number;
            right: number;
            bottom: number;
          }): {
            x: number;
            y: number;
            width: number;
            height: number;
          } {
            const localLeft = bounds.left - columnLeft;
            const localTop = bounds.top - marginTop;
            const localRight = bounds.right - columnLeft;
            const localBottom = bounds.bottom - marginTop;

            return {
              x: Math.max(0, localLeft),
              y: localTop,
              width: Math.max(0, localRight - localLeft),
              height: Math.max(0, localBottom - localTop),
            };
          }

          function clamp(value: number, min: number, max: number): number {
            return Math.min(Math.max(value, min), max);
          }

          function parseRgbComponent(component: string): number | null {
            const trimmed = component.trim();

            if (trimmed.endsWith('%')) {
              const percent = parseFloat(trimmed.slice(0, -1));
              if (Number.isNaN(percent)) {
                return null;
              }

              return (clamp(percent, 0, 100) / 100) * 255;
            }

            const value = parseFloat(trimmed);
            if (Number.isNaN(value)) {
              return null;
            }

            return clamp(value, 0, 255);
          }

          function parseAlphaComponent(component: string): number | null {
            const trimmed = component.trim();

            if (trimmed.endsWith('%')) {
              const percent = parseFloat(trimmed.slice(0, -1));
              if (Number.isNaN(percent)) {
                return null;
              }

              return clamp(percent, 0, 100) / 100;
            }

            const value = parseFloat(trimmed);
            if (Number.isNaN(value)) {
              return null;
            }

            return clamp(value, 0, 1);
          }

          function parseCssColorToRgba(
            color: string,
          ): { r: number; g: number; b: number; a: number } | null {
            const rgbMatch = color.trim().match(/^rgba?\(([^)]+)\)$/i);
            if (!rgbMatch) {
              return null;
            }

            const parts = rgbMatch[1].split(',').map((part) => part.trim());
            if (parts.length < 3 || parts.length > 4) {
              return null;
            }

            const red = parseRgbComponent(parts[0]);
            const green = parseRgbComponent(parts[1]);
            const blue = parseRgbComponent(parts[2]);
            const alpha = parts.length === 4 ? parseAlphaComponent(parts[3]) : 1;

            if (red === null || green === null || blue === null || alpha === null) {
              return null;
            }

            return { r: red, g: green, b: blue, a: alpha };
          }

          const inkGrayByColor = new Map<string, number>();

          function cssColorToInkGray(color: string): number {
            const cached = inkGrayByColor.get(color);
            if (cached !== undefined) {
              return cached;
            }

            const parsed = parseCssColorToRgba(color);
            if (!parsed) {
              inkGrayByColor.set(color, 0);
              return 0;
            }

            const luminance = 0.2126 * parsed.r + 0.7152 * parsed.g + 0.0722 * parsed.b;
            const grayOnWhite = 255 - parsed.a * (255 - luminance);
            const gray = clamp(grayOnWhite, 0, 255);

            const levels = Math.max(2, Math.round(grayLevels));
            const step = 255 / (levels - 1);
            const quantizedGray = Math.round(gray / step) * step;
            const quantized = Math.round(clamp(quantizedGray, 0, 255));

            inkGrayByColor.set(color, quantized);
            return quantized;
          }

          const measurementCanvas = document.createElement('canvas');
          const measurementContext = measurementCanvas.getContext('2d');
          const descenderByStyle = new Map<string, number>();

          function estimateDescenderPx(style: {
            fontFamily: string;
            fontSize: number;
            fontWeight: number;
            fontStyle: 'normal' | 'italic';
          }): number {
            const key = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.fontStyle}`;
            const cached = descenderByStyle.get(key);
            if (cached !== undefined) {
              return cached;
            }

            const fallback = Math.max(1, style.fontSize * 0.2);
            if (!measurementContext) {
              descenderByStyle.set(key, fallback);
              return fallback;
            }

            measurementContext.font = `${style.fontStyle} normal ${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
            const metrics = measurementContext.measureText('Hg');

            let descender = metrics.actualBoundingBoxDescent;
            if (!Number.isFinite(descender) || descender <= 0) {
              descender = fallback;
            }

            descenderByStyle.set(key, descender);
            return descender;
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

          // Extract text runs in this column.
          // Important: preserve exact glyph order/spacing from Chromium layout.
          // We intentionally avoid caret probing and whitespace normalization.
          const walker = document.createTreeWalker(
            document.querySelector('.cadence-content') || document.body,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode: (node) => {
                const textContent = node.textContent ?? '';
                if (textContent.length === 0) {
                  return NodeFilter.FILTER_REJECT;
                }

                const parentElement = node.parentElement;
                if (!parentElement) {
                  return NodeFilter.FILTER_REJECT;
                }

                const parentTag = parentElement.tagName;
                if (parentTag === 'SCRIPT' || parentTag === 'STYLE' || parentTag === 'NOSCRIPT') {
                  return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
              },
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
              inkGray: cssColorToInkGray(computedStyle.color),
            };

            const textContent = textNode.textContent ?? '';
            if (textContent.length === 0) {
              continue;
            }

            const charRange = document.createRange();
            let fragmentText = '';
            let fragmentBounds: {
              left: number;
              top: number;
              right: number;
              bottom: number;
            } | null = null;
            let lastFragmentChar = '';
            let lastFragmentCharRect: {
              left: number;
              top: number;
              right: number;
              bottom: number;
            } | null = null;

            const flushFragment = (): void => {
              if (!fragmentBounds || fragmentText.length === 0) {
                fragmentText = '';
                fragmentBounds = null;
                lastFragmentChar = '';
                lastFragmentCharRect = null;
                return;
              }

              const pageCoords = toPageCoordsFromBounds(fragmentBounds);
              if (pageCoords.width <= 0 || pageCoords.height <= 0) {
                fragmentText = '';
                fragmentBounds = null;
                lastFragmentChar = '';
                lastFragmentCharRect = null;
                return;
              }

              const descenderPx = estimateDescenderPx(style);
              const baselineY =
                pageCoords.y + pageCoords.height - Math.min(descenderPx, pageCoords.height);

              textRuns.push({
                text: fragmentText,
                ...pageCoords,
                baselineY,
                spanId,
                style,
              });

              fragmentText = '';
              fragmentBounds = null;
              lastFragmentChar = '';
              lastFragmentCharRect = null;
            };

            for (let offset = 0; offset < textContent.length; ) {
              const codePoint = textContent.codePointAt(offset);
              if (codePoint === undefined) {
                break;
              }

              const char = String.fromCodePoint(codePoint);
              const nextOffset = offset + (codePoint > 0xffff ? 2 : 1);

              charRange.setStart(textNode, offset);
              charRange.setEnd(textNode, nextOffset);

              const charRects = charRange.getClientRects();
              let charRect: DOMRect | null = null;

              for (let i = 0; i < charRects.length; i++) {
                const rect = charRects[i];
                if (rect.height === 0) continue;
                if (!isInColumn(rect)) continue;
                charRect = rect;
                break;
              }

              if (!charRect) {
                flushFragment();
                offset = nextOffset;
                continue;
              }

              const normalizedChar = /\s/u.test(char) ? ' ' : char;
              if (normalizedChar === ' ' && charRect.width <= 0.5) {
                offset = nextOffset;
                continue;
              }

              const collapsedWhitespaceRectTolerancePx = 1;
              const isCollapsedWhitespaceDuplicate =
                normalizedChar === ' ' &&
                lastFragmentChar === ' ' &&
                lastFragmentCharRect !== null &&
                Math.abs(charRect.left - lastFragmentCharRect.left) <=
                  collapsedWhitespaceRectTolerancePx &&
                Math.abs(charRect.top - lastFragmentCharRect.top) <=
                  collapsedWhitespaceRectTolerancePx &&
                Math.abs(charRect.right - lastFragmentCharRect.right) <=
                  collapsedWhitespaceRectTolerancePx &&
                Math.abs(charRect.bottom - lastFragmentCharRect.bottom) <=
                  collapsedWhitespaceRectTolerancePx;

              if (isCollapsedWhitespaceDuplicate) {
                offset = nextOffset;
                continue;
              }

              const lineTolerancePx = 1;
              const sameLine =
                fragmentBounds &&
                Math.abs(charRect.top - fragmentBounds.top) <= lineTolerancePx &&
                Math.abs(charRect.bottom - fragmentBounds.bottom) <= lineTolerancePx;

              if (!fragmentBounds || !sameLine) {
                // Keep all glyphs on the same visual line in one run, even when
                // CSS creates large horizontal gaps (e.g., hanging indents/tabs).
                flushFragment();
                fragmentText = normalizedChar;
                fragmentBounds = {
                  left: charRect.left,
                  top: charRect.top,
                  right: charRect.right,
                  bottom: charRect.bottom,
                };
                lastFragmentChar = normalizedChar;
                lastFragmentCharRect = {
                  left: charRect.left,
                  top: charRect.top,
                  right: charRect.right,
                  bottom: charRect.bottom,
                };
                offset = nextOffset;
                continue;
              }

              fragmentText += normalizedChar;
              fragmentBounds.left = Math.min(fragmentBounds.left, charRect.left);
              fragmentBounds.top = Math.min(fragmentBounds.top, charRect.top);
              fragmentBounds.right = Math.max(fragmentBounds.right, charRect.right);
              fragmentBounds.bottom = Math.max(fragmentBounds.bottom, charRect.bottom);
              lastFragmentChar = normalizedChar;
              lastFragmentCharRect = {
                left: charRect.left,
                top: charRect.top,
                right: charRect.right,
                bottom: charRect.bottom,
              };
              offset = nextOffset;
            }

            flushFragment();
          }

          // Drop standalone whitespace runs.
          // Their horizontal gaps are already encoded by absolute x positions,
          // and emitting thousands of isolated space-only runs hurts visual quality
          // while bloating the bundle payload.
          const withoutWhitespaceOnlyRuns = textRuns.filter((run) => !/^\s+$/u.test(run.text));

          // Dedupe exact runs (including style), preserving first occurrence order.
          const seenRunKeys = new Set<string>();
          const dedupedRuns = withoutWhitespaceOnlyRuns.filter((run) => {
            const styleKey = `${run.style.fontFamily}|${run.style.fontSize}|${run.style.fontWeight}|${run.style.fontStyle}|${run.style.inkGray}`;
            const key = `${run.text}|${run.x}|${run.y}|${run.width}|${run.height}|${run.baselineY}|${run.spanId ?? ''}|${styleKey}`;
            if (seenRunKeys.has(key)) {
              return false;
            }
            seenRunKeys.add(key);
            return true;
          });

          return { textRuns: dedupedRuns, spanRects };
        },
        {
          colLeft,
          columnWidth,
          marginTop: contentArea.top,
          marginLeft: contentArea.left,
          grayLevels: EINK_GRAY_LEVELS,
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
        contentX: contentArea.left,
        contentY: contentArea.top,
        textRuns: pageData.textRuns,
        spanRects: pageData.spanRects,
        firstSpanId: visibleSpanIds[0] || '',
        lastSpanId: visibleSpanIds[visibleSpanIds.length - 1] || '',
      });
    }

    logNewRoutingWarnings();
    assertNoFatalRoutingIssues();

    const compactedPages = pages.filter(
      (chapterPage) => chapterPage.textRuns.length > 0 || chapterPage.spanRects.length > 0,
    );

    const droppedEmptyPages = pages.length - compactedPages.length;
    if (droppedEmptyPages > 0) {
      for (let i = 0; i < compactedPages.length; i++) {
        compactedPages[i]!.pageId = `${content.chapterId}_p${String(i + 1).padStart(4, '0')}`;
        compactedPages[i]!.pageIndex = i;
      }
      console.log(`      Dropped ${droppedEmptyPages} empty page(s)`);
    }

    return compactedPages;
  } finally {
    await page.close();
  }
}

/**
 * Paginate multiple chapters and return all pages with global indices
 */
export async function paginateChapters(
  contents: NormalizedContent[],
  profile: DeviceProfile,
  container?: EPUBContainer,
): Promise<Page[]> {
  const allPages: Page[] = [];
  let globalPageIndex = 0;

  for (const content of contents) {
    console.log(`  Paginating chapter: ${content.chapterId}`);
    const pages = await paginateContent(content, profile, container);

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

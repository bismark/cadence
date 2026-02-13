import { describe, expect, it } from 'vitest';
import type { EPUBContainer, NormalizedContent } from '../src/types.js';
import {
  classifyPaginationRequestUrl,
  createEpubResourceRouteHandler,
  createPaginationRoutingDiagnostics,
  isCriticalPaginationResource,
  throwOnPaginationRoutingFailures,
} from '../src/layout/paginate.js';

type MockRoute = {
  request(): {
    url(): string;
    headers(): Record<string, string>;
    resourceType(): string;
  };
  fulfill(options: { status: number; contentType: string; body: string | Buffer }): Promise<void>;
  continue(): Promise<void>;
  fulfilledStatuses: number[];
  continuedCount: number;
};

function createMockRoute(
  url: string,
  resourceType = 'stylesheet',
  referer = 'https://epub.local/OEBPS/chapter-1.xhtml',
): MockRoute {
  const fulfilledStatuses: number[] = [];
  let continuedCount = 0;

  return {
    request: () => ({
      url: () => url,
      headers: () => ({ referer }),
      resourceType: () => resourceType,
    }),
    fulfill: async (options) => {
      fulfilledStatuses.push(options.status);
    },
    continue: async () => {
      continuedCount += 1;
    },
    fulfilledStatuses,
    get continuedCount() {
      return continuedCount;
    },
  };
}

const testContent: NormalizedContent = {
  chapterId: 'chapter-1',
  xhtmlPath: 'OEBPS/chapter-1.xhtml',
  html: '<!doctype html><html><head></head><body></body></html>',
  spanIds: [],
};

function createMissingResourceContainer(): EPUBContainer {
  return {
    opfPath: 'OEBPS/content.opf',
    readFile: async () => {
      throw new Error('missing');
    },
    listFiles: async () => [],
    close: async () => {},
  };
}

function createStylesheetContainer(css: string): EPUBContainer {
  return {
    opfPath: 'OEBPS/content.opf',
    readFile: async (path: string) => {
      if (path !== 'OEBPS/styles/base.css') {
        throw new Error('missing');
      }

      return Buffer.from(css, 'utf-8');
    },
    listFiles: async () => ['OEBPS/styles/base.css'],
    close: async () => {},
  };
}

describe('pagination resource request policy', () => {
  it('allows EPUB virtual-origin requests and decodes paths', () => {
    expect(classifyPaginationRequestUrl('https://epub.local/OEBPS/styles/base.css')).toEqual({
      kind: 'epub-resource',
      path: 'OEBPS/styles/base.css',
    });
  });

  it('blocks absolute non-EPUB stylesheet URLs', () => {
    const result = classifyPaginationRequestUrl('https://example.com/theme.css');

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason).toContain('not allowed');
    }
  });

  it('rejects invalid encoded EPUB virtual-origin paths', () => {
    const result = classifyPaginationRequestUrl('https://epub.local/%E0%A4%A.css');

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason).toContain('invalid EPUB resource path');
    }
  });

  it('treats missing stylesheet/font resources as pagination-critical', () => {
    expect(isCriticalPaginationResource('OEBPS/styles/base.css', 'stylesheet')).toBe(true);
    expect(isCriticalPaginationResource('OEBPS/fonts/book.woff2', 'font')).toBe(true);
    expect(isCriticalPaginationResource('OEBPS/images/cover.png', 'image')).toBe(false);
  });

  it('records blocked external requests as fatal routing issues', async () => {
    const diagnostics = createPaginationRoutingDiagnostics();
    const handler = createEpubResourceRouteHandler(
      createMissingResourceContainer(),
      testContent,
      diagnostics,
    );

    const route = createMockRoute('https://evil.example.com/steal.css', 'stylesheet');
    await handler(route);

    expect(route.fulfilledStatuses).toEqual([403]);
    expect(diagnostics.fatalIssues).toHaveLength(1);
    expect(diagnostics.fatalIssues[0]).toContain('blocked non-EPUB request');
  });

  it('marks missing stylesheet/font resources as fatal and surfaces failure', async () => {
    const diagnostics = createPaginationRoutingDiagnostics();
    const handler = createEpubResourceRouteHandler(
      createMissingResourceContainer(),
      testContent,
      diagnostics,
    );

    const route = createMockRoute('https://epub.local/OEBPS/styles/missing.css', 'stylesheet');
    await handler(route);

    expect(route.fulfilledStatuses).toEqual([404]);
    expect(diagnostics.fatalIssues).toHaveLength(1);
    expect(diagnostics.fatalIssues[0]).toContain(
      'missing EPUB resource "OEBPS/styles/missing.css"',
    );

    expect(() => throwOnPaginationRoutingFailures(testContent.chapterId, diagnostics)).toThrow(
      /Pagination resource policy violations/,
    );
  });

  it('records warnings when stylesheet content is sanitized', async () => {
    const diagnostics = createPaginationRoutingDiagnostics();
    const handler = createEpubResourceRouteHandler(
      createStylesheetContainer(
        '.cover { background-image: url("https://evil.example.com/x.png"); color: #111; }',
      ),
      testContent,
      diagnostics,
    );

    const route = createMockRoute('https://epub.local/OEBPS/styles/base.css', 'stylesheet');
    await handler(route);

    expect(route.fulfilledStatuses).toEqual([200]);
    expect(diagnostics.fatalIssues).toHaveLength(0);
    expect(diagnostics.warningIssues).toHaveLength(1);
    expect(diagnostics.warningIssues[0]).toContain('sanitized stylesheet');
  });

  it('keeps missing non-critical assets as warnings', async () => {
    const diagnostics = createPaginationRoutingDiagnostics();
    const handler = createEpubResourceRouteHandler(
      createMissingResourceContainer(),
      testContent,
      diagnostics,
    );

    const route = createMockRoute('https://epub.local/OEBPS/images/missing.png', 'image');
    await handler(route);

    expect(route.fulfilledStatuses).toEqual([404]);
    expect(diagnostics.fatalIssues).toHaveLength(0);
    expect(diagnostics.warningIssues).toHaveLength(1);
    expect(diagnostics.warningIssues[0]).toContain('critical=no');
  });
});

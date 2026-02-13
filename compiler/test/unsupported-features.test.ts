import { describe, expect, it, vi } from 'vitest';
import type { EPUBContainer, OPFPackage } from '../src/types.js';
import {
  logUnsupportedFeatureScanResult,
  scanUnsupportedFeatures,
  type UnsupportedFeatureScanResult,
} from '../src/validation/unsupported-features.js';

function createInMemoryContainer(files: Record<string, string>, opfPath: string): EPUBContainer {
  return {
    opfPath,

    async readFile(path: string): Promise<Buffer> {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`File not found in EPUB: ${path}`);
      }

      return Buffer.from(content, 'utf-8');
    },

    async listFiles(): Promise<string[]> {
      return Object.keys(files);
    },

    async close(): Promise<void> {
      // no-op for in-memory container
    },
  };
}

describe('unsupported feature scanner', () => {
  it('detects high-risk features with chapter/file warnings and grouped summary counts', async () => {
    const opfPath = 'OPS/package.opf';

    const files: Record<string, string> = {
      [opfPath]: `
        <package rendition:layout="pre-paginated" xmlns:rendition="http://www.idpf.org/vocab/rendition/#">
          <metadata>
            <meta property="rendition:layout">pre-paginated</meta>
          </metadata>
        </package>
      `,
      'OPS/chapter1.xhtml': `
        <html xmlns="http://www.w3.org/1999/xhtml" dir="rtl">
          <head>
            <link rel="stylesheet" href="styles/main.css" />
          </head>
          <body>
            <table><tr><td>Cell</td></tr></table>
            <ruby>漢<rt>kan</rt></ruby>
            <math><mi>x</mi></math>
            <svg><text>Hello</text></svg>
          </body>
        </html>
      `,
      'OPS/styles/main.css': `
        .vertical { writing-mode: vertical-rl; text-orientation: upright; }
        .floaty { float: left; position: absolute; }
      `,
    };

    const container = createInMemoryContainer(files, opfPath);
    const opf: OPFPackage = {
      title: 'Fixture',
      manifest: new Map([
        ['chapter-1', { id: 'chapter-1', href: 'OPS/chapter1.xhtml', mediaType: 'application/xhtml+xml' }],
        ['styles', { id: 'styles', href: 'OPS/styles/main.css', mediaType: 'text/css' }],
        [
          'fxl',
          {
            id: 'fxl',
            href: 'OPS/fixed.xhtml',
            mediaType: 'application/xhtml+xml',
            properties: ['rendition:layout-pre-paginated'],
          },
        ],
      ]),
      spine: [{ idref: 'chapter-1', linear: true }],
      mediaOverlays: new Map(),
    };

    const result = await scanUnsupportedFeatures(container, opf, [
      { id: 'chapter-1', href: 'OPS/chapter1.xhtml' },
    ]);

    expect(new Set(result.warnings.map((warning) => warning.code))).toEqual(
      new Set([
        'fixed-layout',
        'table-layout',
        'positioned-layout',
        'ruby-text',
        'mathml-content',
        'svg-text-flow',
        'rtl-direction',
        'vertical-writing-mode',
      ]),
    );

    for (const warning of result.warnings) {
      expect(warning.filePath.length).toBeGreaterThan(0);
      if (warning.code !== 'fixed-layout') {
        expect(warning.chapterId).toBe('chapter-1');
      }
    }

    const summaryByCode = new Map(result.summary.map((item) => [item.code, item]));

    expect(summaryByCode.get('fixed-layout')?.level).toBe('unsupported');
    expect(summaryByCode.get('table-layout')?.level).toBe('degraded');
    expect(summaryByCode.get('positioned-layout')?.warningCount).toBe(1);

    expect(result.unsupportedWarningCount).toBeGreaterThan(0);
    expect(result.degradedWarningCount).toBeGreaterThan(0);
  });

  it('logs unsupported and degraded sections separately', () => {
    const result: UnsupportedFeatureScanResult = {
      warnings: [
        {
          code: 'fixed-layout',
          label: 'Fixed-layout indicators',
          level: 'unsupported',
          filePath: 'OPS/package.opf',
          detail: 'OPF package metadata declares rendition:layout="pre-paginated"',
        },
        {
          code: 'table-layout',
          label: 'Tables / complex table layout',
          level: 'degraded',
          filePath: 'OPS/chapter1.xhtml',
          chapterId: 'chapter-1',
          detail: 'contains table markup (<table>/<tr>/<td>/...)',
        },
      ],
      summary: [
        {
          code: 'fixed-layout',
          label: 'Fixed-layout indicators',
          level: 'unsupported',
          warningCount: 1,
          chapterCount: 1,
        },
        {
          code: 'table-layout',
          label: 'Tables / complex table layout',
          level: 'degraded',
          warningCount: 1,
          chapterCount: 1,
        },
      ],
      unsupportedWarningCount: 1,
      degradedWarningCount: 1,
    };

    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    });

    try {
      logUnsupportedFeatureScanResult(result);
    } finally {
      logSpy.mockRestore();
    }

    expect(lines.some((line) => line.includes('Unsupported feature summary:'))).toBe(true);
    expect(lines.some((line) => line.includes('Degraded but compiled summary:'))).toBe(true);
    expect(
      lines.some((line) => line.includes('file "OPS/chapter1.xhtml", chapter "chapter-1"')),
    ).toBe(true);
  });
});

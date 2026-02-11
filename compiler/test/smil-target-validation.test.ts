import { describe, expect, it } from 'vitest';
import type { NormalizedContent, Page, Span, TextStyle } from '../src/types.js';
import {
  summarizeSmilIssuesByCode,
  validateSmilToDomTargets,
} from '../src/validation/smil-targets.js';

const baseStyle: TextStyle = {
  fontFamily: 'Noto Serif',
  fontSize: 18,
  fontWeight: 400,
  fontStyle: 'normal',
  inkGray: 0,
};

function makeSpan(overrides: Partial<Span>): Span {
  return {
    id: 's1',
    chapterId: 'chapter-1',
    textRef: 'OEBPS/ch1.xhtml#p1',
    audioSrc: 'audio/ch1.mp3',
    clipBeginMs: 0,
    clipEndMs: 1000,
    ...overrides,
  };
}

function makePage(overrides: Partial<Page>): Page {
  return {
    pageId: 'page-1',
    chapterId: 'chapter-1',
    pageIndex: 0,
    width: 600,
    height: 800,
    textRuns: [],
    spanRects: [],
    firstSpanId: '',
    lastSpanId: '',
    ...overrides,
  };
}

function makeContent(overrides: Partial<NormalizedContent>): NormalizedContent {
  return {
    chapterId: 'chapter-1',
    xhtmlPath: 'OEBPS/ch1.xhtml',
    html: '<!doctype html><html><body><p id="p1">Hello</p></body></html>',
    spanIds: ['s1'],
    ...overrides,
  };
}

describe('validateSmilToDomTargets', () => {
  it('passes when SMIL targets resolve and timed spans are mapped', () => {
    const spans = [makeSpan({ id: 's1' })];
    const pages = [
      makePage({
        spanRects: [{ spanId: 's1', rects: [{ x: 10, y: 20, width: 120, height: 24 }] }],
        textRuns: [
          {
            text: 'Hello',
            x: 10,
            y: 20,
            width: 120,
            height: 24,
            baselineY: 38,
            spanId: 's1',
            style: baseStyle,
          },
        ],
        firstSpanId: 's1',
        lastSpanId: 's1',
      }),
    ];
    const normalizedContents = [makeContent({ spanIds: ['s1'] })];

    const result = validateSmilToDomTargets(spans, pages, normalizedContents);

    expect(result.issues).toHaveLength(0);
    expect(result.unresolvedTextRefCount).toBe(0);
    expect(result.timedSpansWithoutGeometryCount).toBe(0);
  });

  it('reports missing textRef fragments with chapter/span context', () => {
    const spans = [makeSpan({ id: 's-missing-frag', textRef: 'OEBPS/ch1.xhtml' })];
    const pages = [
      makePage({
        spanRects: [
          {
            spanId: 's-missing-frag',
            rects: [{ x: 10, y: 20, width: 120, height: 24 }],
          },
        ],
        textRuns: [
          {
            text: 'Hello',
            x: 10,
            y: 20,
            width: 120,
            height: 24,
            baselineY: 38,
            spanId: 's-missing-frag',
            style: baseStyle,
          },
        ],
      }),
    ];

    const result = validateSmilToDomTargets(spans, pages, [makeContent({})]);

    expect(result.unresolvedTextRefCount).toBe(1);
    expect(result.timedSpansWithoutGeometryCount).toBe(0);
    expect(result.issues[0]).toMatchObject({
      code: 'smil_textref_missing_fragment',
      chapterId: 'chapter-1',
      spanId: 's-missing-frag',
      textRef: 'OEBPS/ch1.xhtml',
    });
  });

  it('reports chapter path mismatches in textRef targets', () => {
    const spans = [makeSpan({ id: 's-path-mismatch', textRef: 'OEBPS/ch2.xhtml#p1' })];
    const pages = [
      makePage({
        spanRects: [
          {
            spanId: 's-path-mismatch',
            rects: [{ x: 10, y: 20, width: 120, height: 24 }],
          },
        ],
      }),
    ];

    const result = validateSmilToDomTargets(spans, pages, [makeContent({})]);

    expect(result.unresolvedTextRefCount).toBe(1);
    expect(result.timedSpansWithoutGeometryCount).toBe(0);
    expect(result.issues[0]).toMatchObject({
      code: 'smil_textref_path_mismatch',
      spanId: 's-path-mismatch',
    });
    expect(result.issues[0]?.message).toContain('does not match chapter XHTML path');
  });

  it('reports missing fragment IDs in chapter XHTML', () => {
    const spans = [makeSpan({ id: 's-missing-id', textRef: 'OEBPS/ch1.xhtml#does-not-exist' })];
    const pages = [
      makePage({
        spanRects: [
          {
            spanId: 's-missing-id',
            rects: [{ x: 10, y: 20, width: 120, height: 24 }],
          },
        ],
      }),
    ];

    const result = validateSmilToDomTargets(spans, pages, [makeContent({})]);

    expect(result.unresolvedTextRefCount).toBe(1);
    expect(result.issues[0]).toMatchObject({
      code: 'smil_textref_fragment_not_found',
      spanId: 's-missing-id',
    });
  });

  it('reports timed spans with no mapped geometry/text', () => {
    const spans = [makeSpan({ id: 's-unmapped', textRef: 'OEBPS/ch1.xhtml#p1' })];
    const normalizedContents = [makeContent({ spanIds: ['s-unmapped'] })];

    const result = validateSmilToDomTargets(spans, [], normalizedContents);

    expect(result.unresolvedTextRefCount).toBe(0);
    expect(result.timedSpansWithoutGeometryCount).toBe(1);
    expect(result.issues[0]).toMatchObject({
      code: 'timed_span_without_geometry_text',
      spanId: 's-unmapped',
    });
  });

  it('summarizes issue counts grouped by issue code', () => {
    const result = validateSmilToDomTargets(
      [
        makeSpan({ id: 'missing-fragment', textRef: 'OEBPS/ch1.xhtml' }),
        makeSpan({ id: 'missing-id-1', textRef: 'OEBPS/ch1.xhtml#missing' }),
        makeSpan({ id: 'missing-id-2', textRef: 'OEBPS/ch1.xhtml#missing' }),
        makeSpan({ id: 'unmapped', textRef: 'OEBPS/ch1.xhtml#p1' }),
      ],
      [
        makePage({
          spanRects: [{ spanId: 'missing-fragment', rects: [{ x: 0, y: 0, width: 10, height: 10 }] }],
          textRuns: [
            {
              text: 'ok',
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              baselineY: 8,
              spanId: 'missing-fragment',
              style: baseStyle,
            },
          ],
        }),
      ],
      [makeContent({})],
    );

    const counts = summarizeSmilIssuesByCode(result.issues);

    expect(counts).toEqual([
      { code: 'smil_textref_missing_fragment', count: 1 },
      { code: 'smil_textref_fragment_not_found', count: 2 },
      { code: 'timed_span_without_geometry_text', count: 3 },
    ]);
  });
});

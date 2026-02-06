import { describe, expect, it } from 'vitest';
import { splitSpansAcrossPages } from '../src/layout/split-spans-across-pages.js';
import type { Page, Span, TextStyle } from '../src/types.js';

const baseStyle: TextStyle = {
  fontFamily: 'Noto Serif',
  fontSize: 18,
  fontWeight: 400,
  fontStyle: 'normal',
  color: '#000000',
};

function makePage(overrides: Partial<Page>): Page {
  return {
    pageId: 'page-0',
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

describe('splitSpansAcrossPages', () => {
  it('splits timed spans proportionally by text character count and rewrites page references', () => {
    const spans: Span[] = [
      {
        id: 's1',
        chapterId: 'chapter-1',
        textRef: 'chapter.xhtml#s1',
        audioSrc: 'audio/ch1.mp3',
        clipBeginMs: 0,
        clipEndMs: 900,
      },
      {
        id: 's2',
        chapterId: 'chapter-1',
        textRef: 'chapter.xhtml#s2',
        audioSrc: 'audio/ch1.mp3',
        clipBeginMs: 900,
        clipEndMs: 1200,
      },
    ];

    const pages: Page[] = [
      makePage({
        pageId: 'p0',
        pageIndex: 0,
        spanRects: [
          {
            spanId: 's1',
            rects: [{ x: 10, y: 10, width: 100, height: 20 }],
          },
        ],
        textRuns: [
          {
            text: 'abc',
            x: 10,
            y: 10,
            width: 100,
            height: 20,
            spanId: 's1',
            style: baseStyle,
          },
        ],
        firstSpanId: 's1',
        lastSpanId: 's1',
      }),
      makePage({
        pageId: 'p1',
        pageIndex: 1,
        spanRects: [
          {
            spanId: 's1',
            rects: [{ x: 10, y: 30, width: 120, height: 20 }],
          },
          {
            spanId: 's2',
            rects: [{ x: 10, y: 60, width: 120, height: 20 }],
          },
        ],
        textRuns: [
          {
            text: 'abcdef',
            x: 10,
            y: 30,
            width: 120,
            height: 20,
            spanId: 's1',
            style: baseStyle,
          },
          {
            text: 'next',
            x: 10,
            y: 60,
            width: 120,
            height: 20,
            spanId: 's2',
            style: baseStyle,
          },
        ],
        firstSpanId: 's1',
        lastSpanId: 's2',
      }),
    ];

    const result = splitSpansAcrossPages(spans, pages);

    expect(result.splitSpanCount).toBe(1);
    expect(result.createdSpanCount).toBe(1);
    expect(result.spans).toHaveLength(3);

    const [s1Page0, s1Page1, s2] = result.spans;

    expect(s1Page0.id).toBe('s1__p0');
    expect(s1Page1.id).toBe('s1__p1');
    expect(s2.id).toBe('s2');

    expect(s1Page0.clipBeginMs).toBe(0);
    expect(s1Page0.clipEndMs).toBeCloseTo(300, 6);
    expect(s1Page1.clipBeginMs).toBeCloseTo(300, 6);
    expect(s1Page1.clipEndMs).toBe(900);

    expect(result.pages[0].spanRects[0]?.spanId).toBe('s1__p0');
    expect(result.pages[1].spanRects[0]?.spanId).toBe('s1__p1');
    expect(result.pages[1].spanRects[1]?.spanId).toBe('s2');
    expect(result.pages[1].firstSpanId).toBe('s1__p1');
    expect(result.pages[1].lastSpanId).toBe('s2');

    expect(result.pages[0].textRuns[0]?.spanId).toBe('s1__p0');
    expect(result.pages[1].textRuns[0]?.spanId).toBe('s1__p1');
  });

  it('falls back to rect area when text runs are missing', () => {
    const spans: Span[] = [
      {
        id: 's3',
        chapterId: 'chapter-1',
        textRef: 'chapter.xhtml#s3',
        audioSrc: 'audio/ch1.mp3',
        clipBeginMs: 100,
        clipEndMs: 200,
      },
    ];

    const pages: Page[] = [
      makePage({
        pageId: 'p2',
        pageIndex: 2,
        spanRects: [
          {
            spanId: 's3',
            rects: [{ x: 0, y: 0, width: 75, height: 10 }],
          },
        ],
        firstSpanId: 's3',
        lastSpanId: 's3',
      }),
      makePage({
        pageId: 'p3',
        pageIndex: 3,
        spanRects: [
          {
            spanId: 's3',
            rects: [{ x: 0, y: 0, width: 25, height: 10 }],
          },
        ],
        firstSpanId: 's3',
        lastSpanId: 's3',
      }),
    ];

    const result = splitSpansAcrossPages(spans, pages);

    expect(result.splitSpanCount).toBe(1);
    expect(result.spans).toHaveLength(2);

    const [s3Page2, s3Page3] = result.spans;
    expect(s3Page2.id).toBe('s3__p2');
    expect(s3Page3.id).toBe('s3__p3');

    expect(s3Page2.clipBeginMs).toBe(100);
    expect(s3Page2.clipEndMs).toBeCloseTo(175, 6);
    expect(s3Page3.clipBeginMs).toBeCloseTo(175, 6);
    expect(s3Page3.clipEndMs).toBe(200);
  });

  it('does not split spans without valid timing', () => {
    const spans: Span[] = [
      {
        id: 'untimed',
        chapterId: 'chapter-1',
        textRef: 'chapter.xhtml#untimed',
        audioSrc: '',
        clipBeginMs: -1,
        clipEndMs: -1,
      },
    ];

    const pages: Page[] = [
      makePage({
        pageId: 'p4',
        pageIndex: 4,
        spanRects: [
          {
            spanId: 'untimed',
            rects: [{ x: 0, y: 0, width: 100, height: 20 }],
          },
        ],
        firstSpanId: 'untimed',
        lastSpanId: 'untimed',
      }),
      makePage({
        pageId: 'p5',
        pageIndex: 5,
        spanRects: [
          {
            spanId: 'untimed',
            rects: [{ x: 0, y: 0, width: 100, height: 20 }],
          },
        ],
        firstSpanId: 'untimed',
        lastSpanId: 'untimed',
      }),
    ];

    const result = splitSpansAcrossPages(spans, pages);

    expect(result.splitSpanCount).toBe(0);
    expect(result.createdSpanCount).toBe(0);
    expect(result.spans).toEqual(spans);
    expect(result.pages).toEqual(pages);
  });
});

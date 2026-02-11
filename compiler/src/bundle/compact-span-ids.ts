import type { Page, Span } from '../types.js';

export interface CompactSpanIdsResult {
  spans: Span[];
  pages: Page[];
  idMap: Map<string, string>;
}

/**
 * Replace verbose source span IDs (e.g. EPUB/SMIL/sentence-derived IDs) with compact
 * deterministic IDs (s0, s1, s2, ...).
 *
 * This reduces repeated string payload in pages/*.json and spans.jsonl without changing
 * player behavior.
 */
export function compactSpanIds(spans: Span[], pages: Page[]): CompactSpanIdsResult {
  if (spans.length === 0) {
    return {
      spans,
      pages,
      idMap: new Map(),
    };
  }

  const seenOriginalIds = new Set<string>();
  for (const span of spans) {
    if (seenOriginalIds.has(span.id)) {
      throw new Error(`Cannot compact span IDs: duplicate span ID "${span.id}"`);
    }
    seenOriginalIds.add(span.id);
  }

  const idMap = new Map<string, string>();
  spans.forEach((span, index) => {
    idMap.set(span.id, `s${index.toString(36)}`);
  });

  const remapSpanId = (spanId: string): string => idMap.get(spanId) ?? spanId;

  const compactedSpans: Span[] = spans.map((span) => ({
    ...span,
    id: remapSpanId(span.id),
  }));

  const compactedPages: Page[] = pages.map((page) => {
    const spanRects = page.spanRects.map((spanRect) => ({
      ...spanRect,
      spanId: remapSpanId(spanRect.spanId),
    }));

    const textRuns = page.textRuns.map((textRun) => {
      if (!textRun.spanId) {
        return textRun;
      }

      return {
        ...textRun,
        spanId: remapSpanId(textRun.spanId),
      };
    });

    const visibleSpanIds = spanRects.map((spanRect) => spanRect.spanId);

    return {
      ...page,
      textRuns,
      spanRects,
      firstSpanId: page.firstSpanId ? remapSpanId(page.firstSpanId) : visibleSpanIds[0] || '',
      lastSpanId:
        page.lastSpanId ? remapSpanId(page.lastSpanId) : visibleSpanIds[visibleSpanIds.length - 1] || '',
    };
  });

  return {
    spans: compactedSpans,
    pages: compactedPages,
    idMap,
  };
}

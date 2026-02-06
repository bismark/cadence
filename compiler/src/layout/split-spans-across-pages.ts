import type { Page, Span } from '../types.js';

interface SplitPart {
  pageIndex: number;
  span: Span;
}

interface SplitPlan {
  parts: SplitPart[];
  idByPageIndex: Map<number, string>;
}

export interface SplitSpansAcrossPagesResult {
  spans: Span[];
  pages: Page[];
  splitSpanCount: number;
  createdSpanCount: number;
}

interface PageSpanMetrics {
  charCount: number;
  rectArea: number;
}

/**
 * Split timed spans that visually cross page boundaries.
 *
 * When a single span appears on multiple pages, we create one derived span per page,
 * split timing proportionally (char count first, rect area fallback), and rewrite page
 * references so each page points to its page-specific span ID.
 */
export function splitSpansAcrossPages(spans: Span[], pages: Page[]): SplitSpansAcrossPagesResult {
  if (spans.length === 0 || pages.length === 0) {
    return {
      spans,
      pages,
      splitSpanCount: 0,
      createdSpanCount: 0,
    };
  }

  const metricsBySpan = collectPageMetricsBySpan(pages);
  const usedSpanIds = new Set(spans.map((span) => span.id));
  const splitPlans = new Map<string, SplitPlan>();

  for (const span of spans) {
    if (!hasValidTiming(span)) {
      continue;
    }

    const pageMetrics = metricsBySpan.get(span.id);
    if (!pageMetrics || pageMetrics.size <= 1) {
      continue;
    }

    const sortedPages = [...pageMetrics.entries()].sort((a, b) => a[0] - b[0]);
    const weights = getSplitWeights(sortedPages);
    const weightSum = weights.reduce((sum, value) => sum + value, 0);

    if (weightSum <= 0) {
      continue;
    }

    const duration = span.clipEndMs - span.clipBeginMs;
    let currentStart = span.clipBeginMs;
    const parts: SplitPart[] = [];
    const idByPageIndex = new Map<number, string>();

    for (let i = 0; i < sortedPages.length; i++) {
      const [pageIndex] = sortedPages[i];
      const isLast = i === sortedPages.length - 1;
      const allocatedDuration = isLast
        ? span.clipEndMs - currentStart
        : (duration * weights[i]) / weightSum;
      const currentEnd = isLast ? span.clipEndMs : currentStart + allocatedDuration;

      const splitId = makeUniqueSplitSpanId(span.id, pageIndex, usedSpanIds);
      const splitSpan: Span = {
        ...span,
        id: splitId,
        clipBeginMs: currentStart,
        clipEndMs: currentEnd,
      };

      parts.push({ pageIndex, span: splitSpan });
      idByPageIndex.set(pageIndex, splitId);
      currentStart = currentEnd;
    }

    splitPlans.set(span.id, { parts, idByPageIndex });
  }

  if (splitPlans.size === 0) {
    return {
      spans,
      pages,
      splitSpanCount: 0,
      createdSpanCount: 0,
    };
  }

  const splitSpans: Span[] = [];
  for (const span of spans) {
    const splitPlan = splitPlans.get(span.id);
    if (!splitPlan) {
      splitSpans.push(span);
      continue;
    }

    splitSpans.push(...splitPlan.parts.map((part) => part.span));
  }

  const splitPages: Page[] = pages.map((page) => {
    const remapSpanId = (spanId: string): string => {
      const splitPlan = splitPlans.get(spanId);
      if (!splitPlan) {
        return spanId;
      }
      return splitPlan.idByPageIndex.get(page.pageIndex) ?? spanId;
    };

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
      firstSpanId: visibleSpanIds[0] || '',
      lastSpanId: visibleSpanIds[visibleSpanIds.length - 1] || '',
    };
  });

  return {
    spans: splitSpans,
    pages: splitPages,
    splitSpanCount: splitPlans.size,
    createdSpanCount: splitSpans.length - spans.length,
  };
}

function hasValidTiming(span: Span): boolean {
  return span.clipBeginMs >= 0 && span.clipEndMs > span.clipBeginMs;
}

function collectPageMetricsBySpan(pages: Page[]): Map<string, Map<number, PageSpanMetrics>> {
  const metricsBySpan = new Map<string, Map<number, PageSpanMetrics>>();

  const getOrCreateMetrics = (spanId: string, pageIndex: number): PageSpanMetrics => {
    let byPage = metricsBySpan.get(spanId);
    if (!byPage) {
      byPage = new Map<number, PageSpanMetrics>();
      metricsBySpan.set(spanId, byPage);
    }

    let metrics = byPage.get(pageIndex);
    if (!metrics) {
      metrics = { charCount: 0, rectArea: 0 };
      byPage.set(pageIndex, metrics);
    }

    return metrics;
  };

  for (const page of pages) {
    for (const spanRect of page.spanRects) {
      const metrics = getOrCreateMetrics(spanRect.spanId, page.pageIndex);
      for (const rect of spanRect.rects) {
        metrics.rectArea += rect.width * rect.height;
      }
    }

    for (const textRun of page.textRuns) {
      if (!textRun.spanId) {
        continue;
      }

      const metrics = getOrCreateMetrics(textRun.spanId, page.pageIndex);
      metrics.charCount += textRun.text.length;
    }
  }

  return metricsBySpan;
}

function getSplitWeights(entries: Array<[number, PageSpanMetrics]>): number[] {
  const totalChars = entries.reduce((sum, [, metrics]) => sum + metrics.charCount, 0);
  if (totalChars > 0) {
    return entries.map(([, metrics]) => Math.max(metrics.charCount, 1));
  }

  const totalRectArea = entries.reduce((sum, [, metrics]) => sum + metrics.rectArea, 0);
  if (totalRectArea > 0) {
    return entries.map(([, metrics]) => Math.max(metrics.rectArea, 1));
  }

  return entries.map(() => 1);
}

function makeUniqueSplitSpanId(
  originalSpanId: string,
  pageIndex: number,
  usedIds: Set<string>,
): string {
  const baseId = `${originalSpanId}__p${pageIndex}`;
  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }

  let suffix = 1;
  let candidate = `${baseId}_${suffix}`;
  while (usedIds.has(candidate)) {
    suffix++;
    candidate = `${baseId}_${suffix}`;
  }

  usedIds.add(candidate);
  return candidate;
}

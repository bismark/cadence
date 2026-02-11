import type { Page, SerializedPage, SerializedTextRun, TextStyle } from '../types.js';

export interface CompactPageStylesResult {
  pages: SerializedPage[];
  styles: TextStyle[];
}

/**
 * Deduplicate repeated text styles across all pages and replace per-run style objects
 * with compact numeric style IDs.
 */
export function compactPageStyles(pages: Page[]): CompactPageStylesResult {
  const styles: TextStyle[] = [];
  const styleIdByKey = new Map<string, number>();

  const getStyleId = (style: TextStyle): number => {
    const key = JSON.stringify(style);
    const existing = styleIdByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const styleId = styles.length;
    styles.push(style);
    styleIdByKey.set(key, styleId);
    return styleId;
  };

  const compactedPages: SerializedPage[] = pages.map((page) => {
    const textRuns: SerializedTextRun[] = page.textRuns.map((run) => ({
      text: run.text,
      x: run.x,
      y: run.y,
      width: run.width,
      height: run.height,
      baselineY: run.baselineY,
      ...(run.spanId ? { spanId: run.spanId } : {}),
      styleId: getStyleId(run.style),
    }));

    return {
      pageId: page.pageId,
      chapterId: page.chapterId,
      pageIndex: page.pageIndex,
      width: page.width,
      height: page.height,
      textRuns,
      spanRects: page.spanRects,
      firstSpanId: page.firstSpanId,
      lastSpanId: page.lastSpanId,
    };
  });

  return {
    pages: compactedPages,
    styles,
  };
}

import { posix } from 'node:path';
import * as parse5 from 'parse5';
import type { NormalizedContent, Page, Span } from '../types.js';

type Node = parse5.DefaultTreeAdapterMap['node'];
type Element = parse5.DefaultTreeAdapterMap['element'];
type NodeWithChildNodes = Node & { childNodes: Node[] };

export type SmilToDomIssueCode =
  | 'smil_textref_missing_fragment'
  | 'smil_textref_path_mismatch'
  | 'smil_textref_fragment_not_found'
  | 'smil_textref_unknown_chapter'
  | 'timed_span_without_geometry_text';

export interface SmilToDomValidationIssue {
  code: SmilToDomIssueCode;
  chapterId: string;
  spanId: string;
  textRef: string;
  message: string;
}

export interface SmilToDomValidationResult {
  issues: SmilToDomValidationIssue[];
  unresolvedTextRefCount: number;
  timedSpansWithoutGeometryCount: number;
}

export interface SmilToDomIssueCount {
  code: SmilToDomIssueCode;
  count: number;
}

interface ChapterTargetIndex {
  xhtmlPath: string;
  fragmentIds: Set<string>;
}

const ISSUE_CODE_ORDER: SmilToDomIssueCode[] = [
  'smil_textref_missing_fragment',
  'smil_textref_path_mismatch',
  'smil_textref_fragment_not_found',
  'smil_textref_unknown_chapter',
  'timed_span_without_geometry_text',
];

/**
 * Validate that SMIL text references map to real chapter DOM targets and
 * that timed spans have mapped page geometry/text.
 */
export function validateSmilToDomTargets(
  spans: Span[],
  pages: Page[],
  normalizedContents: NormalizedContent[],
): SmilToDomValidationResult {
  const issues: SmilToDomValidationIssue[] = [];
  const unresolvedSpanIds = new Set<string>();
  const timedSpansWithoutGeometry = new Set<string>();

  const chapterIndex = buildChapterTargetIndex(normalizedContents);
  const spanIdsWithRects = collectSpanIdsWithRects(pages);
  const spanIdsWithTextRuns = collectSpanIdsWithTextRuns(pages);

  for (const span of spans) {
    const chapter = chapterIndex.get(span.chapterId);
    const { path, fragment } = splitTextRef(span.textRef);

    if (!chapter) {
      issues.push({
        code: 'smil_textref_unknown_chapter',
        chapterId: span.chapterId,
        spanId: span.id,
        textRef: span.textRef,
        message: `chapter "${span.chapterId}" has no normalized XHTML content`,
      });
      unresolvedSpanIds.add(span.id);
    } else if (!fragment) {
      issues.push({
        code: 'smil_textref_missing_fragment',
        chapterId: span.chapterId,
        spanId: span.id,
        textRef: span.textRef,
        message: `textRef has no fragment target (#id), expected "${chapter.xhtmlPath}#..."`,
      });
      unresolvedSpanIds.add(span.id);
    } else if (path !== chapter.xhtmlPath) {
      issues.push({
        code: 'smil_textref_path_mismatch',
        chapterId: span.chapterId,
        spanId: span.id,
        textRef: span.textRef,
        message: `textRef path "${path}" does not match chapter XHTML path "${chapter.xhtmlPath}"`,
      });
      unresolvedSpanIds.add(span.id);
    } else if (!chapter.fragmentIds.has(fragment)) {
      issues.push({
        code: 'smil_textref_fragment_not_found',
        chapterId: span.chapterId,
        spanId: span.id,
        textRef: span.textRef,
        message: `fragment "${fragment}" not found in chapter XHTML "${chapter.xhtmlPath}"`,
      });
      unresolvedSpanIds.add(span.id);
    }

    if (isTimedSpan(span) && !spanIdsWithRects.has(span.id) && !spanIdsWithTextRuns.has(span.id)) {
      issues.push({
        code: 'timed_span_without_geometry_text',
        chapterId: span.chapterId,
        spanId: span.id,
        textRef: span.textRef,
        message:
          'timed span has no mapped span rects or text runs on any paginated page (highlight/seek will desync)',
      });
      timedSpansWithoutGeometry.add(span.id);
    }
  }

  return {
    issues,
    unresolvedTextRefCount: unresolvedSpanIds.size,
    timedSpansWithoutGeometryCount: timedSpansWithoutGeometry.size,
  };
}

export function logSmilToDomValidationResult(result: SmilToDomValidationResult): void {
  if (result.issues.length === 0) {
    console.log('  All SMIL-to-DOM target checks passed');
    return;
  }

  for (const issue of result.issues) {
    console.log(`  Warning: ${formatSmilToDomIssue(issue)}`);
  }

  console.log(
    `  Summary: ${result.unresolvedTextRefCount} unresolved textRef target(s), ` +
      `${result.timedSpansWithoutGeometryCount} timed span(s) with no mapped geometry/text`,
  );

  const issueCounts = summarizeSmilIssuesByCode(result.issues);
  if (issueCounts.length > 0) {
    console.log('  Issue counts by code:');
    console.log('    code                                count');
    console.log('    ----------------------------------- -----');
    for (const row of issueCounts) {
      console.log(`    ${row.code.padEnd(35)} ${row.count.toString().padStart(5)}`);
    }
  }
}

export function formatSmilToDomIssue(issue: SmilToDomValidationIssue): string {
  return `[${issue.code}] chapter=${issue.chapterId} span=${issue.spanId} textRef="${issue.textRef}" ${issue.message}`;
}

export function summarizeSmilIssuesByCode(
  issues: SmilToDomValidationIssue[],
): SmilToDomIssueCount[] {
  const counts = new Map<SmilToDomIssueCode, number>();

  for (const issue of issues) {
    counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  }

  return ISSUE_CODE_ORDER.filter((code) => counts.has(code)).map((code) => ({
    code,
    count: counts.get(code) ?? 0,
  }));
}

function buildChapterTargetIndex(
  normalizedContents: NormalizedContent[],
): Map<string, ChapterTargetIndex> {
  const index = new Map<string, ChapterTargetIndex>();

  for (const content of normalizedContents) {
    index.set(content.chapterId, {
      xhtmlPath: normalizeEpubPath(content.xhtmlPath),
      fragmentIds: extractElementIds(content.html),
    });
  }

  return index;
}

function collectSpanIdsWithRects(pages: Page[]): Set<string> {
  const ids = new Set<string>();

  for (const page of pages) {
    for (const spanRect of page.spanRects) {
      ids.add(spanRect.spanId);
    }
  }

  return ids;
}

function collectSpanIdsWithTextRuns(pages: Page[]): Set<string> {
  const ids = new Set<string>();

  for (const page of pages) {
    for (const run of page.textRuns) {
      if (run.spanId) {
        ids.add(run.spanId);
      }
    }
  }

  return ids;
}

function splitTextRef(textRef: string): { path: string; fragment: string | null } {
  const hashIndex = textRef.indexOf('#');
  if (hashIndex < 0) {
    return {
      path: normalizeEpubPath(textRef),
      fragment: null,
    };
  }

  const path = normalizeEpubPath(textRef.slice(0, hashIndex));
  const rawFragment = textRef.slice(hashIndex + 1);

  if (!rawFragment) {
    return { path, fragment: null };
  }

  return {
    path,
    fragment: decodeFragment(rawFragment),
  };
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function normalizeEpubPath(path: string): string {
  const normalizedInput = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalizedPath = posix.normalize(normalizedInput);

  if (normalizedPath === '.' || normalizedPath === '/') {
    return '';
  }

  return normalizedPath.replace(/^\/+/, '');
}

function extractElementIds(html: string): Set<string> {
  const ids = new Set<string>();
  const document = parse5.parse(html);
  collectElementIds(document, ids);
  return ids;
}

function collectElementIds(node: Node, ids: Set<string>): void {
  if (isElement(node)) {
    const id = getElementId(node);
    if (id) {
      ids.add(id);
    }
  }

  if (!hasChildNodes(node)) {
    return;
  }

  for (const child of node.childNodes) {
    collectElementIds(child, ids);
  }
}

function getElementId(element: Element): string | null {
  const idAttr = element.attrs.find((attr) => attr.name === 'id');
  return idAttr?.value ?? null;
}

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function hasChildNodes(node: Node): node is NodeWithChildNodes {
  return 'childNodes' in node;
}

function isTimedSpan(span: Span): boolean {
  return span.clipBeginMs >= 0 && span.clipEndMs > span.clipBeginMs;
}

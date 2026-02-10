/**
 * Core TypeScript interfaces for the Cadence Compiler
 */

/**
 * Device profile for rendering configuration
 */
export interface DeviceProfile {
  name: string;
  viewportWidth: number;
  viewportHeight: number;
  margins: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
}

/**
 * A span represents a single synchronized text+audio segment from SMIL
 */
export interface Span {
  id: string;
  chapterId: string;
  textRef: string; // XHTML fragment reference (e.g., "chapter.xhtml#para1")
  audioSrc: string;
  clipBeginMs: number;
  clipEndMs: number;
}

/**
 * A rectangle representing a span's position on a page
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rectangles for a single span on a page (may have multiple rects for wrapped text)
 */
export interface PageSpanRect {
  spanId: string;
  rects: Rect[];
}

/**
 * Style information for a text run
 */
export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  color: string;
}

/**
 * A positioned text run on a page
 */
export interface TextRun {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  spanId?: string; // Present if this run is part of a synchronized span
  style: TextStyle;
}

/**
 * A rendered page with positioned text and spans
 */
export interface Page {
  pageId: string;
  chapterId: string;
  pageIndex: number;
  width: number;
  height: number;
  textRuns: TextRun[];
  spanRects: PageSpanRect[];
  firstSpanId: string;
  lastSpanId: string;
}

/**
 * OPF manifest item
 */
export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  mediaOverlay?: string;
}

/**
 * OPF spine item reference
 */
export interface SpineItem {
  idref: string;
  linear: boolean;
}

/**
 * Parsed OPF package document
 */
export interface OPFPackage {
  title: string;
  identifier?: string; // dc:identifier (often ISBN)
  manifest: Map<string, ManifestItem>;
  spine: SpineItem[];
  mediaOverlays: Map<string, string>; // spine item id -> SMIL href
}

/**
 * Chapter metadata for bundle output
 */
export interface Chapter {
  id: string;
  title: string;
  xhtmlHref: string;
  smilHref?: string;
  audioFiles: string[];
}

/**
 * Bundle metadata
 */
export interface BundleMeta {
  bundleVersion: string;
  bundleId: string; // Stable identifier for this book (from dc:identifier or hash)
  profile: string;
  title: string;
  pages: number;
  spans: number;
}

/**
 * Table of contents entry (for chapter navigation)
 */
export interface TocEntry {
  title: string;
  pageIndex: number; // Global page index where this chapter starts
}

/**
 * Span entry for JSONL output (includes pageIndex for lookup)
 * Note: clipBeginMs/clipEndMs are global timestamps in the single audio.opus file
 */
export interface SpanEntry {
  id: string;
  clipBeginMs: number;
  clipEndMs: number;
  pageIndex: number; // Global page index
}

/**
 * EPUB container interface for reading files from the archive
 */
export interface EPUBContainer {
  opfPath: string;
  readFile(path: string): Promise<Buffer>;
  listFiles(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * Normalized HTML content ready for pagination
 */
export interface NormalizedContent {
  chapterId: string;
  xhtmlPath: string; // Source XHTML path in EPUB package (for URL base resolution)
  html: string;
  spanIds: string[]; // IDs of spans present in this content
}

/**
 * Compilation result from the full pipeline
 */
export interface CompilationResult {
  meta: BundleMeta;
  spans: SpanEntry[];
  pages: Page[];
  audioFiles: string[];
}

/**
 * Result of validating compilation output
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[]; // Fatal issues
  warnings: string[]; // Non-fatal issues
}

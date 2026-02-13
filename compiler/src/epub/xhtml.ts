import { posix } from 'node:path';
import * as parse5 from 'parse5';
import {
  didSanitizeCss,
  isSafeStylesheetHref,
  sanitizeCssDeclarationListForPagination,
  sanitizeCssForPagination,
} from '../css/sanitization.js';
import { generateProfileCSS } from '../device-profiles/profiles.js';
import type { DeviceProfile, EPUBContainer, NormalizedContent, Span } from '../types.js';

type Node = parse5.DefaultTreeAdapterMap['node'];
type Element = parse5.DefaultTreeAdapterMap['element'];
type TextNode = parse5.DefaultTreeAdapterMap['textNode'];
type Document = parse5.DefaultTreeAdapterMap['document'];

interface PublisherStylesExtraction {
  stylesheetHrefs: string[];
  blockedStylesheetHrefs: string[];
  inlineStyleBlocks: string[];
  sanitizedInlineStyleBlockCount: number;
  droppedInlineStyleBlockCount: number;
}

const NON_CONTENT_TAGS = new Set([
  'script',
  'style',
  'title',
  'meta',
  'link',
  'noscript',
  'iframe',
  'object',
  'embed',
]);

const URL_LIKE_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'poster', 'formaction']);

/**
 * Parse and normalize XHTML content for pagination
 */
export async function normalizeXHTML(
  container: EPUBContainer,
  xhtmlPath: string,
  chapterId: string,
  spans: Span[],
  profile: DeviceProfile,
): Promise<NormalizedContent> {
  const content = await container.readFile(xhtmlPath);
  const html = content.toString('utf-8');

  // Parse the XHTML
  const document = parse5.parse(html);

  // Build a map of fragment IDs to span IDs for this chapter.
  // Important: only map spans whose textRef path matches this chapter XHTML path.
  const chapterPath = normalizeEpubPath(xhtmlPath);
  const fragmentToSpan = new Map<string, string>();
  for (const span of spans) {
    if (span.chapterId !== chapterId) {
      continue;
    }

    const hashIndex = span.textRef.indexOf('#');
    if (hashIndex < 0) {
      continue;
    }

    const textRefPath = normalizeEpubPath(span.textRef.slice(0, hashIndex));
    if (textRefPath !== chapterPath) {
      continue;
    }

    const fragmentId = decodeTextRefFragment(span.textRef.slice(hashIndex + 1));
    if (!fragmentId) {
      continue;
    }

    fragmentToSpan.set(fragmentId, span.id);
  }

  // Process the document to add data-span-id attributes
  processNode(document, fragmentToSpan);

  // Extract the body content
  const body = findBody(document);
  if (!body) {
    throw new Error(`No body element found in ${xhtmlPath}`);
  }

  const publisherStyles = extractPublisherStylesFromRawHTML(html);

  for (const href of publisherStyles.blockedStylesheetHrefs) {
    console.warn(`  Warning: Ignoring unsafe stylesheet link "${href}" in ${xhtmlPath}`);
  }

  if (publisherStyles.sanitizedInlineStyleBlockCount > 0) {
    console.warn(
      `  Warning: Sanitized ${publisherStyles.sanitizedInlineStyleBlockCount} inline stylesheet block(s)` +
        ` in ${xhtmlPath}`,
    );
  }

  if (publisherStyles.droppedInlineStyleBlockCount > 0) {
    console.warn(
      `  Warning: Dropped ${publisherStyles.droppedInlineStyleBlockCount} inline stylesheet block(s)` +
        ` after sanitization in ${xhtmlPath}`,
    );
  }

  // Generate normalized HTML
  const normalizedHtml = generateNormalizedHTML(
    body,
    profile,
    chapterId,
    publisherStyles.stylesheetHrefs,
    publisherStyles.inlineStyleBlocks,
  );

  // Collect span IDs that are present in this content
  const presentSpanIds = Array.from(fragmentToSpan.values());

  return {
    chapterId,
    xhtmlPath,
    html: normalizedHtml,
    spanIds: presentSpanIds,
  };
}

function normalizeEpubPath(path: string): string {
  const normalizedInput = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalizedPath = posix.normalize(normalizedInput);

  if (normalizedPath === '.' || normalizedPath === '/') {
    return '';
  }

  return normalizedPath.replace(/^\/+/, '');
}

function decodeTextRefFragment(fragment: string): string {
  if (!fragment) {
    return '';
  }

  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * Process a node to add data-span-id attributes where needed
 */
function processNode(node: Node, fragmentToSpan: Map<string, string>): void {
  if (isElement(node)) {
    // Check if this element has an ID that maps to a span
    const id = getAttribute(node, 'id');
    if (id && fragmentToSpan.has(id)) {
      const spanId = fragmentToSpan.get(id)!;
      setAttribute(node, 'data-span-id', spanId);
    }

    // Process child nodes
    for (const child of node.childNodes) {
      processNode(child, fragmentToSpan);
    }
  } else if ('childNodes' in node) {
    // Handle Document nodes which have childNodes but aren't Elements
    for (const child of (node as { childNodes: Node[] }).childNodes) {
      processNode(child, fragmentToSpan);
    }
  }
}

/**
 * Find a direct child of the html element by tag name
 */
function findHtmlChild(document: Document, tagName: string): Element | null {
  for (const node of document.childNodes) {
    if (!isElement(node) || node.tagName !== 'html') {
      continue;
    }

    for (const child of node.childNodes) {
      if (isElement(child) && child.tagName === tagName) {
        return child;
      }
    }
  }

  return null;
}

/**
 * Find the body element in the document
 */
function findBody(document: Document): Element | null {
  return findHtmlChild(document, 'body');
}

/**
 * Extract publisher CSS from source XHTML.
 * - linked stylesheets from <head>
 * - inline <style> blocks (sanitized)
 */
function extractPublisherStylesFromRawHTML(html: string): PublisherStylesExtraction {
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const headContent = headMatch?.[1] ?? '';

  const stylesheetHrefs: string[] = [];
  const blockedStylesheetHrefs: string[] = [];
  const seenStylesheetHref = new Set<string>();

  const linkTagRegex = /<link\b[^>]*>/gi;
  let linkMatch: RegExpExecArray | null;

  while ((linkMatch = linkTagRegex.exec(headContent)) !== null) {
    const linkTag = linkMatch[0];
    const rel = (getAttributeFromTag(linkTag, 'rel') || '').toLowerCase();
    const href = getAttributeFromTag(linkTag, 'href');

    if (!href) {
      continue;
    }

    const relTokens = rel.split(/\s+/).filter(Boolean);
    if (!relTokens.includes('stylesheet')) {
      continue;
    }

    if (seenStylesheetHref.has(href)) {
      continue;
    }

    seenStylesheetHref.add(href);

    if (!isSafeStylesheetHref(href)) {
      blockedStylesheetHrefs.push(href);
      continue;
    }

    stylesheetHrefs.push(href);
  }

  const inlineStyleBlocks: string[] = [];
  let sanitizedInlineStyleBlockCount = 0;
  let droppedInlineStyleBlockCount = 0;

  const styleTagRegex = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  let styleMatch: RegExpExecArray | null;

  while ((styleMatch = styleTagRegex.exec(html)) !== null) {
    const styleTag = `<style${styleMatch[1] ?? ''}>`;
    const type = (getAttributeFromTag(styleTag, 'type') || '').toLowerCase().trim();

    if (type && type !== 'text/css') {
      continue;
    }

    const rawCss = styleMatch[2]?.trim();
    if (!rawCss) {
      continue;
    }

    const sanitization = sanitizeCssForPagination(rawCss);
    if (didSanitizeCss(sanitization.summary)) {
      sanitizedInlineStyleBlockCount += 1;
    }

    const sanitizedCss = sanitization.css.trim();
    if (!sanitizedCss) {
      droppedInlineStyleBlockCount += 1;
      continue;
    }

    inlineStyleBlocks.push(sanitizedCss);
  }

  return {
    stylesheetHrefs,
    blockedStylesheetHrefs,
    inlineStyleBlocks,
    sanitizedInlineStyleBlockCount,
    droppedInlineStyleBlockCount,
  };
}

/**
 * Extract an attribute value from a raw HTML tag
 */
function getAttributeFromTag(tag: string, attributeName: string): string | null {
  const regex = new RegExp(`\\b${attributeName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = tag.match(regex);

  if (!match) {
    return null;
  }

  return match[2] ?? match[3] ?? match[4] ?? null;
}

/**
 * Generate normalized HTML with publisher CSS + profile overrides.
 *
 * CSS precedence:
 * 1) Linked publisher stylesheets
 * 2) Inline publisher style blocks (sanitized)
 * 3) Cadence profile CSS (authoritative for viewport/margins/font policy)
 */
function generateNormalizedHTML(
  body: Element,
  profile: DeviceProfile,
  chapterId: string,
  stylesheetHrefs: string[],
  inlineStyleBlocks: string[],
): string {
  const css = generateProfileCSS(profile);
  const bodyContent = serializeChildren(body);
  const stylesheetLinks = stylesheetHrefs
    .map((href) => `  <link rel="stylesheet" href="${escapeAttr(href)}">`)
    .join('\n');

  const inlineStyles = inlineStyleBlocks
    .map((styleBlock) => `  <style>${styleBlock}</style>`)
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${profile.viewportWidth}, height=${profile.viewportHeight}">
${stylesheetLinks ? `${stylesheetLinks}\n` : ''}${inlineStyles ? `${inlineStyles}\n` : ''}  <style>${css}</style>
</head>
<body>
  <div class="cadence-content" data-chapter-id="${escapeAttr(chapterId)}">
    ${bodyContent}
  </div>
</body>
</html>`;
}

/**
 * Serialize child nodes to HTML string
 */
function serializeChildren(element: Element): string {
  let html = '';
  for (const child of element.childNodes) {
    html += serializeNode(child);
  }
  return html;
}

/**
 * Serialize a single node to HTML string
 */
function serializeNode(node: Node): string {
  if (isTextNode(node)) {
    return escapeHtml(node.value);
  }

  if (isElement(node)) {
    // Skip non-content / unsafe elements
    if (NON_CONTENT_TAGS.has(node.tagName)) {
      return '';
    }

    // Handle void elements
    const voidElements = new Set([
      'area',
      'base',
      'br',
      'col',
      'embed',
      'hr',
      'img',
      'input',
      'param',
      'source',
      'track',
      'wbr',
    ]);

    const attrs = serializeAttributes(node);
    const tagName = node.tagName;

    if (voidElements.has(tagName)) {
      return `<${tagName}${attrs}>`;
    }

    const children = serializeChildren(node);
    return `<${tagName}${attrs}>${children}</${tagName}>`;
  }

  return '';
}

/**
 * Serialize element attributes to HTML string
 */
function serializeAttributes(element: Element): string {
  if (!element.attrs || element.attrs.length === 0) {
    return '';
  }

  const serializedAttributes: string[] = [];

  for (const attr of element.attrs) {
    const name = attr.name;
    const lowerName = name.toLowerCase();

    // Drop event handler attributes (onclick, onload, ...)
    if (lowerName.startsWith('on')) {
      continue;
    }

    // Drop script URL payloads in href/src-like attributes.
    if (URL_LIKE_ATTRIBUTES.has(lowerName) && isUnsafeScriptUrl(attr.value)) {
      continue;
    }

    if (lowerName === 'style') {
      const styleSanitization = sanitizeCssDeclarationListForPagination(attr.value);
      const sanitizedStyle = styleSanitization.css.trim();
      if (!sanitizedStyle) {
        continue;
      }

      serializedAttributes.push(` ${name}="${escapeAttr(sanitizedStyle)}"`);
      continue;
    }

    serializedAttributes.push(` ${name}="${escapeAttr(attr.value)}"`);
  }

  return serializedAttributes.join('');
}

function isUnsafeScriptUrl(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, '').toLowerCase();
  return normalized.startsWith('javascript:') || normalized.startsWith('vbscript:');
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape attribute value
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Type guard for Element nodes
 */
function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

/**
 * Type guard for TextNode
 */
function isTextNode(node: Node): node is TextNode {
  return 'value' in node && !('tagName' in node);
}

/**
 * Get an attribute value from an element
 */
function getAttribute(element: Element, name: string): string | null {
  const attr = element.attrs?.find((a) => a.name === name);
  return attr ? attr.value : null;
}

/**
 * Set an attribute on an element
 */
function setAttribute(element: Element, name: string, value: string): void {
  if (!element.attrs) {
    element.attrs = [];
  }

  const existing = element.attrs.find((a) => a.name === name);
  if (existing) {
    existing.value = value;
  } else {
    element.attrs.push({ name, value });
  }
}

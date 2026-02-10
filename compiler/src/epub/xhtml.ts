import * as parse5 from 'parse5';
import { generateProfileCSS } from '../device-profiles/profiles.js';
import type { DeviceProfile, EPUBContainer, NormalizedContent, Span } from '../types.js';

type Node = parse5.DefaultTreeAdapterMap['node'];
type Element = parse5.DefaultTreeAdapterMap['element'];
type TextNode = parse5.DefaultTreeAdapterMap['textNode'];
type Document = parse5.DefaultTreeAdapterMap['document'];

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

  // Build a map of fragment IDs to span IDs for this chapter
  const fragmentToSpan = new Map<string, string>();
  for (const span of spans) {
    if (span.chapterId === chapterId) {
      // Extract fragment from textRef (e.g., "chapter.xhtml#para1" -> "para1")
      const hashIndex = span.textRef.indexOf('#');
      if (hashIndex !== -1) {
        const fragmentId = span.textRef.substring(hashIndex + 1);
        fragmentToSpan.set(fragmentId, span.id);
      }
    }
  }

  // Process the document to add data-span-id attributes
  processNode(document, fragmentToSpan);

  // Extract the body content
  const body = findBody(document);
  if (!body) {
    throw new Error(`No body element found in ${xhtmlPath}`);
  }

  // Extract stylesheet links from source head so relative CSS references can be resolved in Chromium
  const stylesheetHrefs = extractStylesheetHrefsFromRawHTML(html);

  // Generate normalized HTML
  const normalizedHtml = generateNormalizedHTML(body, profile, chapterId, stylesheetHrefs);

  // Collect span IDs that are present in this content
  const presentSpanIds = Array.from(fragmentToSpan.values());

  return {
    chapterId,
    xhtmlPath,
    html: normalizedHtml,
    spanIds: presentSpanIds,
  };
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
 * Extract linked stylesheet href values from the raw XHTML head
 * We parse raw HTML to avoid quirks where parse5 reparents head children into body.
 */
function extractStylesheetHrefsFromRawHTML(html: string): string[] {
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if (!headMatch) {
    return [];
  }

  const headContent = headMatch[1];
  const hrefs: string[] = [];
  const seen = new Set<string>();

  const linkTagRegex = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkTagRegex.exec(headContent)) !== null) {
    const linkTag = match[0];
    const rel = (getAttributeFromTag(linkTag, 'rel') || '').toLowerCase();
    const href = getAttributeFromTag(linkTag, 'href');

    if (!href) {
      continue;
    }

    const relTokens = rel.split(/\s+/).filter(Boolean);
    if (!relTokens.includes('stylesheet')) {
      continue;
    }

    if (!seen.has(href)) {
      hrefs.push(href);
      seen.add(href);
    }
  }

  return hrefs;
}

/**
 * Extract an attribute value from a raw HTML tag
 */
function getAttributeFromTag(tag: string, attributeName: string): string | null {
  const regex = new RegExp(
    `\\b${attributeName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  );
  const match = tag.match(regex);

  if (!match) {
    return null;
  }

  return match[2] ?? match[3] ?? match[4] ?? null;
}

/**
 * Generate normalized HTML with proper CSS for pagination
 */
function generateNormalizedHTML(
  body: Element,
  profile: DeviceProfile,
  chapterId: string,
  stylesheetHrefs: string[],
): string {
  const css = generateProfileCSS(profile);
  const bodyContent = serializeChildren(body);
  const stylesheetLinks = stylesheetHrefs
    .map((href) => `  <link rel="stylesheet" href="${escapeAttr(href)}">`)
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${profile.viewportWidth}, height=${profile.viewportHeight}">
${stylesheetLinks ? `${stylesheetLinks}\n` : ''}  <style>${css}</style>
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
    // Skip non-content elements
    if (
      node.tagName === 'script' ||
      node.tagName === 'style' ||
      node.tagName === 'title' ||
      node.tagName === 'meta' ||
      node.tagName === 'link'
    ) {
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

  return element.attrs.map((attr) => ` ${attr.name}="${escapeAttr(attr.value)}"`).join('');
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

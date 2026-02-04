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

  // Generate normalized HTML
  const normalizedHtml = generateNormalizedHTML(body, profile, chapterId);

  // Collect span IDs that are present in this content
  const presentSpanIds = Array.from(fragmentToSpan.values());

  return {
    chapterId,
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
 * Find the body element in the document
 */
function findBody(document: Document): Element | null {
  for (const node of document.childNodes) {
    if (isElement(node)) {
      if (node.tagName === 'html') {
        for (const child of node.childNodes) {
          if (isElement(child) && child.tagName === 'body') {
            return child;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Generate normalized HTML with proper CSS for pagination
 */
function generateNormalizedHTML(body: Element, profile: DeviceProfile, chapterId: string): string {
  const css = generateProfileCSS(profile);
  const bodyContent = serializeChildren(body);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${profile.viewportWidth}, height=${profile.viewportHeight}">
  <style>${css}</style>
</head>
<body>
  <div class="cadence-content" data-chapter-id="${chapterId}">
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
    // Skip script and style elements
    if (node.tagName === 'script' || node.tagName === 'style') {
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
      'link',
      'meta',
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

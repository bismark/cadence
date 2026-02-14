import { posix } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { EPUBContainer, OPFPackage, Page, TocEntry } from '../types.js';
import { resolvePath } from './container.js';

type SpineFile = { id: string; href: string };

type XmlNode = Record<string, unknown>;

interface TocTargetNode {
  title: string;
  targetPath: string;
  children: TocTargetNode[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

/**
 * Build ToC entries from EPUB navigation documents (EPUB3 nav preferred, NCX fallback).
 */
export async function buildTocEntries(
  container: EPUBContainer,
  opf: OPFPackage,
  spineFiles: ReadonlyArray<SpineFile>,
  pages: ReadonlyArray<Pick<Page, 'chapterId' | 'pageIndex'>>,
): Promise<TocEntry[]> {
  const firstPageByChapterId = buildFirstPageByChapterId(pages);
  const fallbackToc = buildFallbackToc(spineFiles, firstPageByChapterId);

  const navigationItems = await extractNavigationItems(container, opf);
  if (navigationItems.length === 0) {
    return fallbackToc;
  }

  const chapterIdByPath = buildChapterIdByPath(spineFiles);
  const resolvedToc = flattenNavigationItems(
    navigationItems,
    chapterIdByPath,
    firstPageByChapterId,
  );

  return resolvedToc.length > 0 ? resolvedToc : fallbackToc;
}

async function extractNavigationItems(
  container: EPUBContainer,
  opf: OPFPackage,
): Promise<TocTargetNode[]> {
  if (opf.navPath) {
    try {
      const navItems = await parseNavDocument(container, opf.navPath);
      if (navItems.length > 0) {
        return navItems;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  Warning: Failed to parse EPUB nav document "${opf.navPath}": ${message}`);
    }
  }

  if (opf.ncxPath) {
    try {
      const ncxItems = await parseNcxDocument(container, opf.ncxPath);
      if (ncxItems.length > 0) {
        return ncxItems;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  Warning: Failed to parse EPUB NCX "${opf.ncxPath}": ${message}`);
    }
  }

  return [];
}

async function parseNavDocument(
  container: EPUBContainer,
  navPath: string,
): Promise<TocTargetNode[]> {
  const navXml = stripBom((await container.readFile(navPath)).toString('utf-8'));
  const parsed = parser.parse(navXml);

  const navNodes = collectElementsByLocalName(parsed, 'nav');
  const tocNav = navNodes.find(isTocNavNode) ?? navNodes[0];

  if (!tocNav) {
    return [];
  }

  const listNode = findFirstDescendantListNode(tocNav);

  if (!listNode) {
    return [];
  }

  return parseHtmlTocList(listNode, navPath);
}

function parseHtmlTocList(listNode: XmlNode, sourcePath: string): TocTargetNode[] {
  const result: TocTargetNode[] = [];

  for (const listItemNode of getDirectChildrenByLocalName(listNode, 'li')) {
    const childListNodes = findChildListsForListItem(listItemNode);
    const children = childListNodes.flatMap((node) => parseHtmlTocList(node, sourcePath));

    const anchorNode = findFirstAnchorOutsideNestedLists(listItemNode);
    if (!anchorNode) {
      result.push(...children);
      continue;
    }

    const href = getAttributeValue(anchorNode, 'href');
    const title = normalizeWhitespace(getTextContent(anchorNode));
    const targetPath = href ? resolveNavigationTargetPath(sourcePath, href) : null;

    if (!title || !targetPath) {
      result.push(...children);
      continue;
    }

    result.push({
      title,
      targetPath,
      children,
    });
  }

  return result;
}

function findFirstDescendantListNode(node: XmlNode): XmlNode | null {
  for (const [key, value] of Object.entries(node)) {
    if (key === '#text' || key.startsWith('@_')) {
      continue;
    }

    const localName = getLocalName(key);
    const childNodes = toXmlNodeArray(value);

    if (localName === 'ol' || localName === 'ul') {
      return childNodes[0] ?? null;
    }

    for (const childNode of childNodes) {
      const nestedList = findFirstDescendantListNode(childNode);
      if (nestedList) {
        return nestedList;
      }
    }
  }

  return null;
}

function findChildListsForListItem(listItemNode: XmlNode): XmlNode[] {
  const childLists: XmlNode[] = [];
  collectChildListsForListItem(listItemNode, childLists);
  return childLists;
}

function collectChildListsForListItem(node: XmlNode, childLists: XmlNode[]): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === '#text' || key.startsWith('@_')) {
      continue;
    }

    const localName = getLocalName(key);
    const childNodes = toXmlNodeArray(value);

    if (localName === 'ol' || localName === 'ul') {
      childLists.push(...childNodes);
      continue;
    }

    // Stop traversal at nested list items so we only collect lists that belong
    // to this list item (not deeper descendants' child lists).
    if (localName === 'li') {
      continue;
    }

    for (const childNode of childNodes) {
      collectChildListsForListItem(childNode, childLists);
    }
  }
}

function isTocNavNode(node: XmlNode): boolean {
  const epubType = getAttributeValue(node, 'type');
  const role = getAttributeValue(node, 'role');

  if (hasToken(epubType, 'toc') || hasToken(role, 'doc-toc')) {
    return true;
  }

  return false;
}

async function parseNcxDocument(
  container: EPUBContainer,
  ncxPath: string,
): Promise<TocTargetNode[]> {
  const ncxXml = stripBom((await container.readFile(ncxPath)).toString('utf-8'));
  const parsed = parser.parse(ncxXml);

  const navMapNode = collectElementsByLocalName(parsed, 'navMap')[0];
  if (!navMapNode) {
    return [];
  }

  const navPointNodes = getDirectChildrenByLocalName(navMapNode, 'navPoint');
  return parseNcxNavPoints(navPointNodes, ncxPath);
}

function parseNcxNavPoints(navPoints: XmlNode[], sourcePath: string): TocTargetNode[] {
  const result: TocTargetNode[] = [];

  for (const navPoint of navPoints) {
    const children = parseNcxNavPoints(
      getDirectChildrenByLocalName(navPoint, 'navPoint'),
      sourcePath,
    );

    const labelNode = getDirectChildrenByLocalName(navPoint, 'navLabel')[0];
    const contentNode = getDirectChildrenByLocalName(navPoint, 'content')[0];

    const title = labelNode ? normalizeWhitespace(getTextContent(labelNode)) : '';
    const src = contentNode ? getAttributeValue(contentNode, 'src') : undefined;
    const targetPath = src ? resolveNavigationTargetPath(sourcePath, src) : null;

    if (!title || !targetPath) {
      result.push(...children);
      continue;
    }

    result.push({
      title,
      targetPath,
      children,
    });
  }

  return result;
}

function flattenNavigationItems(
  items: TocTargetNode[],
  chapterIdByPath: Map<string, string>,
  firstPageByChapterId: Map<string, number>,
): TocEntry[] {
  const result: TocEntry[] = [];

  const visit = (nodes: TocTargetNode[], level: number): void => {
    for (const node of nodes) {
      const chapterId = resolveChapterIdForPath(node.targetPath, chapterIdByPath);
      if (chapterId) {
        const pageIndex = firstPageByChapterId.get(chapterId);
        if (pageIndex !== undefined) {
          result.push({
            title: node.title,
            pageIndex,
            level,
          });
        }
      }

      if (node.children.length > 0) {
        visit(node.children, level + 1);
      }
    }
  };

  visit(items, 0);
  return result;
}

function buildFallbackToc(
  spineFiles: ReadonlyArray<SpineFile>,
  firstPageByChapterId: Map<string, number>,
): TocEntry[] {
  const toc: TocEntry[] = [];

  for (const chapter of spineFiles) {
    const pageIndex = firstPageByChapterId.get(chapter.id);
    if (pageIndex === undefined) {
      continue;
    }

    toc.push({
      title: chapter.id,
      pageIndex,
      level: 0,
    });
  }

  return toc;
}

function buildFirstPageByChapterId(
  pages: ReadonlyArray<Pick<Page, 'chapterId' | 'pageIndex'>>,
): Map<string, number> {
  const firstPageByChapterId = new Map<string, number>();

  for (const page of pages) {
    const existing = firstPageByChapterId.get(page.chapterId);
    if (existing === undefined || page.pageIndex < existing) {
      firstPageByChapterId.set(page.chapterId, page.pageIndex);
    }
  }

  return firstPageByChapterId;
}

function buildChapterIdByPath(spineFiles: ReadonlyArray<SpineFile>): Map<string, string> {
  const chapterIdByPath = new Map<string, string>();

  for (const chapter of spineFiles) {
    const normalizedPath = normalizePackagePath(chapter.href);
    if (!normalizedPath) {
      continue;
    }

    chapterIdByPath.set(normalizedPath, chapter.id);
    chapterIdByPath.set(normalizedPath.toLowerCase(), chapter.id);

    const decodedPath = decodeURIComponentSafe(normalizedPath);
    chapterIdByPath.set(decodedPath, chapter.id);
    chapterIdByPath.set(decodedPath.toLowerCase(), chapter.id);
  }

  return chapterIdByPath;
}

function resolveChapterIdForPath(
  targetPath: string,
  chapterIdByPath: Map<string, string>,
): string | undefined {
  const normalizedPath = normalizePackagePath(targetPath);
  if (!normalizedPath) {
    return undefined;
  }

  return (
    chapterIdByPath.get(normalizedPath) ??
    chapterIdByPath.get(normalizedPath.toLowerCase()) ??
    chapterIdByPath.get(decodeURIComponentSafe(normalizedPath)) ??
    chapterIdByPath.get(decodeURIComponentSafe(normalizedPath).toLowerCase())
  );
}

function resolveNavigationTargetPath(sourcePath: string, href: string): string | null {
  const trimmedHref = href.trim();
  if (!trimmedHref) {
    return null;
  }

  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmedHref)) {
    return null;
  }

  const hrefWithoutQuery = trimmedHref.split('?')[0] ?? trimmedHref;

  if (hrefWithoutQuery.startsWith('#')) {
    const normalizedSourcePath = normalizePackagePath(sourcePath);
    return normalizedSourcePath || null;
  }

  const resolved = resolvePath(sourcePath, hrefWithoutQuery);
  const normalized = normalizePackagePath(resolved);

  return normalized || null;
}

function normalizePackagePath(path: string): string {
  const withoutFragment = path.split('#')[0] ?? path;
  const withoutQuery = withoutFragment.split('?')[0] ?? withoutFragment;
  const normalized = posix.normalize(withoutQuery.replace(/\\/g, '/').replace(/^\/+/, ''));

  if (!normalized || normalized === '.' || normalized === '..') {
    return '';
  }

  return normalized.replace(/^\/+/, '');
}

function decodeURIComponentSafe(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, '');
}

function hasToken(value: string | undefined, token: string): boolean {
  if (!value) {
    return false;
  }

  return value
    .split(/\s+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .includes(token.toLowerCase());
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function asXmlNode(value: unknown): XmlNode | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as XmlNode;
}

function toXmlNodeArray(value: unknown): XmlNode[] {
  if (Array.isArray(value)) {
    return value.map(asXmlNode).filter((node): node is XmlNode => node !== null);
  }

  const node = asXmlNode(value);
  return node ? [node] : [];
}

function getLocalName(name: string): string {
  const colonIndex = name.indexOf(':');
  return colonIndex >= 0 ? name.slice(colonIndex + 1) : name;
}

function getAttributeValue(node: XmlNode, localName: string): string | undefined {
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith('@_') || typeof value !== 'string') {
      continue;
    }

    const attributeLocalName = getLocalName(key.slice(2));
    if (attributeLocalName === localName) {
      return value;
    }
  }

  return undefined;
}

function getDirectChildrenByLocalName(node: XmlNode, localName: string): XmlNode[] {
  const result: XmlNode[] = [];

  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key === '#text') {
      continue;
    }

    if (getLocalName(key) !== localName) {
      continue;
    }

    result.push(...toXmlNodeArray(value));
  }

  return result;
}

function collectElementsByLocalName(
  value: unknown,
  localName: string,
  output: XmlNode[] = [],
): XmlNode[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectElementsByLocalName(item, localName, output);
    }
    return output;
  }

  const node = asXmlNode(value);
  if (!node) {
    return output;
  }

  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith('@_')) {
      continue;
    }

    const childNodes = toXmlNodeArray(child);
    if (getLocalName(key) === localName) {
      output.push(...childNodes);
    }

    collectElementsByLocalName(child, localName, output);
  }

  return output;
}

function getTextContent(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return normalizeWhitespace(value.map((item) => getTextContent(item)).join(' '));
  }

  const node = asXmlNode(value);
  if (!node) {
    return '';
  }

  const parts: string[] = [];

  const directText = node['#text'];
  if (
    typeof directText === 'string' ||
    typeof directText === 'number' ||
    typeof directText === 'boolean'
  ) {
    parts.push(String(directText));
  }

  for (const [key, child] of Object.entries(node)) {
    if (key === '#text' || key.startsWith('@_')) {
      continue;
    }

    const localName = getLocalName(key);
    if (localName === 'ol' || localName === 'ul') {
      continue;
    }

    const childText = getTextContent(child);
    if (childText) {
      parts.push(childText);
    }
  }

  return normalizeWhitespace(parts.join(' '));
}

function findFirstAnchorOutsideNestedLists(node: XmlNode): XmlNode | null {
  const directAnchors = getDirectChildrenByLocalName(node, 'a');
  if (directAnchors.length > 0) {
    return directAnchors[0] ?? null;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === '#text' || key.startsWith('@_')) {
      continue;
    }

    const localName = getLocalName(key);
    if (localName === 'ol' || localName === 'ul' || localName === 'li') {
      continue;
    }

    for (const childNode of toXmlNodeArray(value)) {
      const anchor = findFirstAnchorOutsideNestedLists(childNode);
      if (anchor) {
        return anchor;
      }
    }
  }

  return null;
}

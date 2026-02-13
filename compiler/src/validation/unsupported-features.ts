import { posix } from 'node:path';
import { resolvePath } from '../epub/container.js';
import type { EPUBContainer, OPFPackage } from '../types.js';

type SpineFile = { id: string; href: string };

export type UnsupportedFeatureCode =
  | 'fixed-layout'
  | 'table-layout'
  | 'positioned-layout'
  | 'ruby-text'
  | 'mathml-content'
  | 'svg-text-flow'
  | 'rtl-direction'
  | 'vertical-writing-mode';

export type UnsupportedFeatureLevel = 'unsupported' | 'degraded';

interface FeatureDefinition {
  label: string;
  level: UnsupportedFeatureLevel;
}

const FEATURE_DEFINITIONS: Record<UnsupportedFeatureCode, FeatureDefinition> = {
  'fixed-layout': {
    label: 'Fixed-layout indicators',
    level: 'unsupported',
  },
  'table-layout': {
    label: 'Tables / complex table layout',
    level: 'degraded',
  },
  'positioned-layout': {
    label: 'Floats / absolute positioning',
    level: 'degraded',
  },
  'ruby-text': {
    label: 'Ruby text annotations',
    level: 'degraded',
  },
  'mathml-content': {
    label: 'MathML content',
    level: 'unsupported',
  },
  'svg-text-flow': {
    label: 'SVG-heavy text flow',
    level: 'degraded',
  },
  'rtl-direction': {
    label: 'RTL directionality',
    level: 'unsupported',
  },
  'vertical-writing-mode': {
    label: 'Vertical writing mode',
    level: 'unsupported',
  },
};

const TABLE_TAG_REGEX =
  /<\s*(?:[a-z0-9_-]+:)?(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col)\b/i;
const RUBY_TAG_REGEX = /<\s*(?:[a-z0-9_-]+:)?(?:ruby|rb|rt|rp)\b/i;
const MATHML_TAG_REGEX = /<\s*(?:[a-z0-9_-]+:)?math\b/i;
const SVG_TAG_REGEX = /<\s*(?:[a-z0-9_-]+:)?svg\b/i;
const DIR_RTL_ATTRIBUTE_REGEX = /\bdir\s*=\s*["']rtl["']/i;

const CSS_FLOAT_REGEX = /\bfloat\s*:\s*(?:left|right|inline-start|inline-end)\b/;
const CSS_ABSOLUTE_POSITION_REGEX = /\bposition\s*:\s*(?:absolute|fixed)\b/;
const CSS_TABLE_LAYOUT_REGEX = /\btable-layout\s*:/;
const CSS_TABLE_DISPLAY_REGEX =
  /\bdisplay\s*:\s*(?:inline-)?table(?:-[a-z-]+)?\b|\bdisplay\s*:\s*table-(?:row|cell|caption|column|column-group|row-group|header-group|footer-group)\b/;
const CSS_DIRECTION_RTL_REGEX = /\bdirection\s*:\s*rtl\b/;
const CSS_UNICODE_BIDI_REGEX =
  /\bunicode-bidi\s*:\s*(?:embed|bidi-override|isolate|isolate-override|plaintext)\b/;
const CSS_WRITING_MODE_VERTICAL_REGEX =
  /\bwriting-mode\s*:\s*(?:vertical(?:-rl|-lr)?|tb-rl|tb-lr|sideways-rl|sideways-lr)\b/;
const CSS_TEXT_ORIENTATION_REGEX = /\btext-orientation\s*:\s*(?:upright|sideways(?:-right)?)\b/;

export interface UnsupportedFeatureWarning {
  code: UnsupportedFeatureCode;
  label: string;
  level: UnsupportedFeatureLevel;
  filePath: string;
  chapterId?: string;
  detail: string;
}

export interface UnsupportedFeatureSummaryItem {
  code: UnsupportedFeatureCode;
  label: string;
  level: UnsupportedFeatureLevel;
  warningCount: number;
  chapterCount: number;
}

export interface UnsupportedFeatureScanResult {
  warnings: UnsupportedFeatureWarning[];
  summary: UnsupportedFeatureSummaryItem[];
  unsupportedWarningCount: number;
  degradedWarningCount: number;
}

/**
 * Scan EPUB sources for high-risk features that are unsupported or likely degraded.
 */
export async function scanUnsupportedFeatures(
  container: EPUBContainer,
  opf: OPFPackage,
  spineFiles: ReadonlyArray<SpineFile>,
): Promise<UnsupportedFeatureScanResult> {
  const warningMap = new Map<string, UnsupportedFeatureWarning>();

  const opfXml = stripBom((await container.readFile(container.opfPath)).toString('utf-8'));
  const fixedLayoutDetails = detectFixedLayoutDetails(opf, opfXml);

  if (fixedLayoutDetails.length > 0) {
    addWarning(warningMap, {
      code: 'fixed-layout',
      filePath: container.opfPath,
      detail: fixedLayoutDetails.join('; '),
    });
  }

  for (const chapter of spineFiles) {
    let xhtml: string;
    try {
      xhtml = stripBom((await container.readFile(chapter.href)).toString('utf-8'));
    } catch {
      continue;
    }

    const markupFeatureDetails = detectFeatureDetailsInMarkup(xhtml);
    for (const [code, detail] of markupFeatureDetails) {
      addWarning(warningMap, {
        code,
        filePath: chapter.href,
        chapterId: chapter.id,
        detail,
      });
    }

    const inlineCssSources = [
      ...extractInlineStyleBlocksFromRawHTML(xhtml).map((css) => ({
        css,
        sourceLabel: 'inline <style> block',
      })),
      ...extractInlineStyleAttributesFromRawHTML(xhtml).map((css) => ({
        css,
        sourceLabel: 'inline style attribute',
      })),
    ];

    for (const source of inlineCssSources) {
      const cssFeatureDetails = detectFeatureDetailsInCss(source.css);
      for (const [code, detail] of cssFeatureDetails) {
        addWarning(warningMap, {
          code,
          filePath: chapter.href,
          chapterId: chapter.id,
          detail: `${source.sourceLabel} ${detail}`,
        });
      }
    }

    const stylesheetHrefs = extractStylesheetHrefsFromRawHTML(xhtml);
    for (const href of stylesheetHrefs) {
      const stylesheetPath = resolveStylesheetPath(chapter.href, href);
      if (!stylesheetPath) {
        continue;
      }

      try {
        const css = stripBom((await container.readFile(stylesheetPath)).toString('utf-8'));
        const cssFeatureDetails = detectFeatureDetailsInCss(css);

        for (const [code, detail] of cssFeatureDetails) {
          addWarning(warningMap, {
            code,
            filePath: stylesheetPath,
            chapterId: chapter.id,
            detail: `linked stylesheet "${href}" ${detail}`,
          });
        }
      } catch {
        // Ignore missing stylesheets in scanner; pagination already validates critical resources.
      }
    }
  }

  const warnings = Array.from(warningMap.values()).sort(sortWarnings);
  const summary = buildSummary(warnings);

  const unsupportedWarningCount = warnings.filter((warning) => warning.level === 'unsupported').length;
  const degradedWarningCount = warnings.length - unsupportedWarningCount;

  return {
    warnings,
    summary,
    unsupportedWarningCount,
    degradedWarningCount,
  };
}

export function logUnsupportedFeatureScanResult(result: UnsupportedFeatureScanResult): void {
  if (result.warnings.length === 0) {
    console.log('  No unsupported/degraded features detected');
    return;
  }

  for (const warning of result.warnings) {
    const categoryLabel = warning.level === 'unsupported' ? 'Unsupported' : 'Degraded but compiled';
    const chapterLabel = warning.chapterId ? `, chapter "${warning.chapterId}"` : '';

    console.log(
      `  ${categoryLabel}: ${warning.label} in file "${warning.filePath}"${chapterLabel} (${warning.detail})`,
    );
  }

  console.log(
    `  Feature warning totals: ${result.unsupportedWarningCount} unsupported, ` +
      `${result.degradedWarningCount} degraded but compiled`,
  );

  const unsupportedSummary = result.summary.filter((item) => item.level === 'unsupported');
  if (unsupportedSummary.length > 0) {
    console.log('  Unsupported feature summary:');
    for (const item of unsupportedSummary) {
      console.log(
        `    - ${item.label}: ${item.warningCount} warning(s) across ${item.chapterCount} location(s)`,
      );
    }
  }

  const degradedSummary = result.summary.filter((item) => item.level === 'degraded');
  if (degradedSummary.length > 0) {
    console.log('  Degraded but compiled summary:');
    for (const item of degradedSummary) {
      console.log(
        `    - ${item.label}: ${item.warningCount} warning(s) across ${item.chapterCount} location(s)`,
      );
    }
  }
}

function detectFixedLayoutDetails(opf: OPFPackage, opfXml: string): string[] {
  const details = new Set<string>();

  const manifestPrePaginated = Array.from(opf.manifest.values()).filter((item) =>
    item.properties?.some((prop) => prop.toLowerCase() === 'rendition:layout-pre-paginated'),
  );

  if (manifestPrePaginated.length > 0) {
    const sample = manifestPrePaginated
      .slice(0, 3)
      .map((item) => `"${item.href}"`)
      .join(', ');

    if (manifestPrePaginated.length > 3) {
      details.add(
        `manifest marks ${manifestPrePaginated.length} items as rendition:layout-pre-paginated (e.g. ${sample})`,
      );
    } else {
      details.add(`manifest marks item(s) as rendition:layout-pre-paginated (${sample})`);
    }
  }

  if (/\brendition:layout\s*=\s*["']pre-paginated["']/i.test(opfXml)) {
    details.add('OPF package metadata declares rendition:layout="pre-paginated"');
  }

  if (/<meta\b[^>]*\bproperty\s*=\s*["']rendition:layout["'][^>]*>\s*pre-paginated\s*<\/meta>/i.test(opfXml)) {
    details.add('OPF metadata contains <meta property="rendition:layout">pre-paginated</meta>');
  }

  const fixedLayoutMetaRegexes = [
    /<meta\b[^>]*\bname\s*=\s*["']fixed-layout["'][^>]*\bcontent\s*=\s*["'](?:true|yes|1)["'][^>]*\/?>/i,
    /<meta\b[^>]*\bcontent\s*=\s*["'](?:true|yes|1)["'][^>]*\bname\s*=\s*["']fixed-layout["'][^>]*\/?>/i,
  ];

  if (fixedLayoutMetaRegexes.some((regex) => regex.test(opfXml))) {
    details.add('OPF metadata contains fixed-layout=true indicator');
  }

  if (/\brendition:layout-pre-paginated\b/i.test(opfXml)) {
    details.add('OPF contains rendition:layout-pre-paginated spine/manifest properties');
  }

  return Array.from(details);
}

function detectFeatureDetailsInMarkup(xhtml: string): Map<UnsupportedFeatureCode, string> {
  const details = new Map<UnsupportedFeatureCode, string>();

  if (TABLE_TAG_REGEX.test(xhtml)) {
    details.set('table-layout', 'contains table markup (<table>/<tr>/<td>/...)');
  }

  if (RUBY_TAG_REGEX.test(xhtml)) {
    details.set('ruby-text', 'contains ruby annotations (<ruby>/<rt>)');
  }

  if (MATHML_TAG_REGEX.test(xhtml)) {
    details.set('mathml-content', 'contains MathML (<math>)');
  }

  if (SVG_TAG_REGEX.test(xhtml)) {
    details.set('svg-text-flow', 'contains inline SVG content (<svg>)');
  }

  if (DIR_RTL_ATTRIBUTE_REGEX.test(xhtml)) {
    details.set('rtl-direction', 'contains dir="rtl" markup');
  }

  return details;
}

function detectFeatureDetailsInCss(css: string): Map<UnsupportedFeatureCode, string> {
  const details = new Map<UnsupportedFeatureCode, string>();
  const normalizedCss = stripCssComments(css).toLowerCase();

  if (CSS_TABLE_LAYOUT_REGEX.test(normalizedCss) || CSS_TABLE_DISPLAY_REGEX.test(normalizedCss)) {
    details.set('table-layout', 'uses table display/layout CSS declarations');
  }

  const usesFloat = CSS_FLOAT_REGEX.test(normalizedCss);
  const usesAbsolutePosition = CSS_ABSOLUTE_POSITION_REGEX.test(normalizedCss);

  if (usesFloat && usesAbsolutePosition) {
    details.set('positioned-layout', 'uses float and absolute/fixed positioning CSS declarations');
  } else if (usesFloat) {
    details.set('positioned-layout', 'uses float CSS declarations');
  } else if (usesAbsolutePosition) {
    details.set('positioned-layout', 'uses absolute/fixed positioning CSS declarations');
  }

  if (CSS_DIRECTION_RTL_REGEX.test(normalizedCss) || CSS_UNICODE_BIDI_REGEX.test(normalizedCss)) {
    details.set('rtl-direction', 'uses RTL directionality CSS (direction/unicode-bidi)');
  }

  if (
    CSS_WRITING_MODE_VERTICAL_REGEX.test(normalizedCss) ||
    CSS_TEXT_ORIENTATION_REGEX.test(normalizedCss)
  ) {
    details.set('vertical-writing-mode', 'uses vertical writing-mode/text-orientation CSS');
  }

  return details;
}

function addWarning(
  warningMap: Map<string, UnsupportedFeatureWarning>,
  warning: {
    code: UnsupportedFeatureCode;
    filePath: string;
    chapterId?: string;
    detail: string;
  },
): void {
  const definition = FEATURE_DEFINITIONS[warning.code];
  const key = [warning.code, warning.filePath, warning.chapterId ?? ''].join('|');
  const existing = warningMap.get(key);

  if (!existing) {
    warningMap.set(key, {
      code: warning.code,
      label: definition.label,
      level: definition.level,
      filePath: warning.filePath,
      chapterId: warning.chapterId,
      detail: warning.detail,
    });
    return;
  }

  if (!existing.detail.includes(warning.detail)) {
    existing.detail = `${existing.detail}; ${warning.detail}`;
  }
}

function buildSummary(
  warnings: ReadonlyArray<UnsupportedFeatureWarning>,
): UnsupportedFeatureSummaryItem[] {
  const summaryByCode = new Map<UnsupportedFeatureCode, { warningCount: number; chapterIds: Set<string> }>();

  for (const warning of warnings) {
    const summary = summaryByCode.get(warning.code) ?? {
      warningCount: 0,
      chapterIds: new Set<string>(),
    };

    summary.warningCount += 1;
    summary.chapterIds.add(warning.chapterId ?? warning.filePath);
    summaryByCode.set(warning.code, summary);
  }

  return Array.from(summaryByCode.entries())
    .map(([code, summary]) => ({
      code,
      label: FEATURE_DEFINITIONS[code].label,
      level: FEATURE_DEFINITIONS[code].level,
      warningCount: summary.warningCount,
      chapterCount: summary.chapterIds.size,
    }))
    .sort(sortSummaryItems);
}

function sortWarnings(a: UnsupportedFeatureWarning, b: UnsupportedFeatureWarning): number {
  const levelOrder = compareLevels(a.level, b.level);
  if (levelOrder !== 0) {
    return levelOrder;
  }

  const labelOrder = a.label.localeCompare(b.label);
  if (labelOrder !== 0) {
    return labelOrder;
  }

  const chapterOrder = (a.chapterId ?? '').localeCompare(b.chapterId ?? '');
  if (chapterOrder !== 0) {
    return chapterOrder;
  }

  return a.filePath.localeCompare(b.filePath);
}

function sortSummaryItems(a: UnsupportedFeatureSummaryItem, b: UnsupportedFeatureSummaryItem): number {
  const levelOrder = compareLevels(a.level, b.level);
  if (levelOrder !== 0) {
    return levelOrder;
  }

  return a.label.localeCompare(b.label);
}

function compareLevels(a: UnsupportedFeatureLevel, b: UnsupportedFeatureLevel): number {
  const order = (level: UnsupportedFeatureLevel): number => (level === 'unsupported' ? 0 : 1);
  return order(a) - order(b);
}

function extractStylesheetHrefsFromRawHTML(html: string): string[] {
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if (!headMatch) {
    return [];
  }

  const hrefs: string[] = [];
  const seen = new Set<string>();
  const linkTagRegex = /<link\b[^>]*>/gi;

  let match: RegExpExecArray | null;
  while ((match = linkTagRegex.exec(headMatch[1] ?? '')) !== null) {
    const linkTag = match[0];
    const rel = (getAttributeFromTag(linkTag, 'rel') ?? '').toLowerCase();
    const href = getAttributeFromTag(linkTag, 'href');

    if (!href) {
      continue;
    }

    const relTokens = rel.split(/\s+/).filter(Boolean);
    if (!relTokens.includes('stylesheet')) {
      continue;
    }

    if (!seen.has(href)) {
      seen.add(href);
      hrefs.push(href);
    }
  }

  return hrefs;
}

function extractInlineStyleBlocksFromRawHTML(html: string): string[] {
  const styleBlocks: string[] = [];
  const styleTagRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

  let match: RegExpExecArray | null;
  while ((match = styleTagRegex.exec(html)) !== null) {
    const css = match[1]?.trim();
    if (css) {
      styleBlocks.push(css);
    }
  }

  return styleBlocks;
}

function extractInlineStyleAttributesFromRawHTML(html: string): string[] {
  const declarations: string[] = [];
  const styleAttrRegex = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;

  let match: RegExpExecArray | null;
  while ((match = styleAttrRegex.exec(html)) !== null) {
    const css = (match[2] ?? match[3] ?? '').trim();
    if (css) {
      declarations.push(css);
    }
  }

  return declarations;
}

function resolveStylesheetPath(chapterPath: string, href: string): string | null {
  const cleanedHref = href.trim().split('#')[0]?.split('?')[0] ?? '';
  if (!cleanedHref) {
    return null;
  }

  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(cleanedHref)) {
    return null;
  }

  const resolved = resolvePath(chapterPath, cleanedHref);
  const normalized = normalizePackagePath(resolved);

  return normalized || null;
}

function normalizePackagePath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, '/').replace(/^\/+/, ''));

  if (!normalized || normalized === '.' || normalized === '..') {
    return '';
  }

  return normalized.replace(/^\/+/, '');
}

function stripCssComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, '');
}

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

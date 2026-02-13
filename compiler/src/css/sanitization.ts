export interface CssSanitizationSummary {
  removedImportCount: number;
  rewrittenUrlCount: number;
  removedDeclarationCount: number;
}

export interface CssSanitizationResult {
  css: string;
  summary: CssSanitizationSummary;
}

const IMPORT_RULE_REGEX = /@import\s+([^;]+);/gi;
const URL_FUNCTION_REGEX = /url\(\s*([^)]*?)\s*\)/gi;
const BEHAVIOR_DECLARATION_REGEX = /\bbehavior\s*:[^;{}]*;?/gi;
const MOZ_BINDING_DECLARATION_REGEX = /\b-moz-binding\s*:[^;{}]*;?/gi;
const EXPRESSION_DECLARATION_REGEX = /[a-z-]+\s*:[^;{}]*expression\s*\([^;{}]*\)[^;{}]*;?/gi;

/**
 * Allow local stylesheet links from the EPUB package only.
 * Absolute/protocol URLs are excluded to avoid external fetches.
 */
export function isSafeStylesheetHref(href: string): boolean {
  const candidate = href.trim();
  if (!candidate) {
    return false;
  }

  if (candidate.startsWith('//')) {
    return false;
  }

  // Reject protocol URLs (http:, https:, data:, javascript:, etc.)
  return !/^[a-z][a-z0-9+.-]*:/i.test(candidate);
}

/**
 * Sanitize CSS for pagination: keep book styling, strip unsafe/high-risk constructs.
 */
export function sanitizeCssForPagination(css: string): CssSanitizationResult {
  const summary = createEmptySummary();

  let sanitized = css;
  sanitized = sanitizeImportRules(sanitized, summary);
  sanitized = stripDangerousDeclarations(sanitized, summary);
  sanitized = rewriteUnsafeUrls(sanitized, summary);

  return {
    css: sanitized,
    summary,
  };
}

/**
 * Sanitize CSS declaration lists (e.g. inline style="...").
 */
export function sanitizeCssDeclarationListForPagination(
  cssDeclarations: string,
): CssSanitizationResult {
  const summary = createEmptySummary();

  let sanitized = cssDeclarations;
  sanitized = stripDangerousDeclarations(sanitized, summary);
  sanitized = rewriteUnsafeUrls(sanitized, summary);

  return {
    css: sanitized,
    summary,
  };
}

export function didSanitizeCss(summary: CssSanitizationSummary): boolean {
  return (
    summary.removedImportCount > 0 ||
    summary.rewrittenUrlCount > 0 ||
    summary.removedDeclarationCount > 0
  );
}

function createEmptySummary(): CssSanitizationSummary {
  return {
    removedImportCount: 0,
    rewrittenUrlCount: 0,
    removedDeclarationCount: 0,
  };
}

function sanitizeImportRules(css: string, summary: CssSanitizationSummary): string {
  return css.replace(IMPORT_RULE_REGEX, (fullRule: string, importTarget: string) => {
    const importUrl = extractImportUrl(importTarget);

    if (!importUrl || !isSafeCssUrl(importUrl)) {
      summary.removedImportCount += 1;
      return '';
    }

    return fullRule;
  });
}

function extractImportUrl(importTarget: string): string | null {
  const fromUrlFunction = importTarget.match(/url\(\s*([^)]*?)\s*\)/i);
  if (fromUrlFunction?.[1]) {
    return unwrapCssUrlValue(fromUrlFunction[1]);
  }

  const fromString = importTarget.match(/(["'])(.*?)\1/);
  if (fromString?.[2]) {
    return fromString[2].trim();
  }

  return null;
}

function stripDangerousDeclarations(css: string, summary: CssSanitizationSummary): string {
  const patterns = [
    BEHAVIOR_DECLARATION_REGEX,
    MOZ_BINDING_DECLARATION_REGEX,
    EXPRESSION_DECLARATION_REGEX,
  ];

  let sanitized = css;

  for (const pattern of patterns) {
    sanitized = sanitized.replace(pattern, (fullMatch: string) => {
      summary.removedDeclarationCount += 1;

      // If declaration was prefixed by a semicolon separator, preserve one.
      // This keeps surrounding declaration syntax stable after removal.
      return fullMatch.trimStart().startsWith(';') ? ';' : '';
    });
  }

  return sanitized;
}

function rewriteUnsafeUrls(css: string, summary: CssSanitizationSummary): string {
  return css.replace(URL_FUNCTION_REGEX, (fullMatch: string, rawValue: string) => {
    const candidate = unwrapCssUrlValue(rawValue);
    if (isSafeCssUrl(candidate)) {
      return fullMatch;
    }

    summary.rewrittenUrlCount += 1;
    return 'url("")';
  });
}

function unwrapCssUrlValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];

  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function isSafeCssUrl(url: string): boolean {
  const candidate = url.trim();
  if (!candidate) {
    return false;
  }

  if (candidate.startsWith('#')) {
    return true;
  }

  if (/^data:/i.test(candidate)) {
    return true;
  }

  if (candidate.startsWith('//')) {
    return false;
  }

  // Any other scheme is treated as external/unsafe.
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    return false;
  }

  return true;
}

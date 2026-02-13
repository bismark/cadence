import { describe, expect, it } from 'vitest';
import {
  didSanitizeCss,
  isSafeStylesheetHref,
  sanitizeCssDeclarationListForPagination,
  sanitizeCssForPagination,
} from '../src/css/sanitization.js';

describe('publisher CSS sanitization', () => {
  it('allows only package-local stylesheet href values', () => {
    expect(isSafeStylesheetHref('styles/base.css')).toBe(true);
    expect(isSafeStylesheetHref('../styles/base.css')).toBe(true);
    expect(isSafeStylesheetHref('/OPS/styles/base.css')).toBe(true);

    expect(isSafeStylesheetHref('https://example.com/theme.css')).toBe(false);
    expect(isSafeStylesheetHref('http://example.com/theme.css')).toBe(false);
    expect(isSafeStylesheetHref('//example.com/theme.css')).toBe(false);
    expect(isSafeStylesheetHref('data:text/css,body{}')).toBe(false);
  });

  it('rewrites unsafe imports and URLs while preserving local CSS', () => {
    const input = `
      @import url("https://evil.example.com/theme.css");
      @import url("../styles/local.css");
      .chapter {
        background-image: url("https://evil.example.com/bg.png");
        color: #222;
      }
      .local {
        background-image: url("../images/bg.png");
      }
      .legacy {
        behavior: url("behavior.htc");
      }
    `;

    const result = sanitizeCssForPagination(input);

    expect(result.css).toContain('@import url("../styles/local.css");');
    expect(result.css).not.toContain('@import url("https://evil.example.com/theme.css");');
    expect(result.css).not.toContain('https://evil.example.com/bg.png');
    expect(result.css).toContain('url("")');
    expect(result.css).toContain('url("../images/bg.png")');
    expect(result.css).not.toContain('behavior:');

    expect(result.summary.removedImportCount).toBe(1);
    expect(result.summary.rewrittenUrlCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.removedDeclarationCount).toBeGreaterThanOrEqual(1);
    expect(didSanitizeCss(result.summary)).toBe(true);
  });

  it('sanitizes unsafe inline style declaration lists', () => {
    const result = sanitizeCssDeclarationListForPagination(
      'background-image:url(https://evil.example.com/x.png); color:#111; width:expression(alert(1));',
    );

    expect(result.css).toContain('color:#111');
    expect(result.css).toContain('url("")');
    expect(result.css).not.toContain('https://evil.example.com/x.png');
    expect(result.css).not.toContain('expression(');
    expect(didSanitizeCss(result.summary)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { extractBreakRulesFromCss } from '../src/index.js';

describe('break hint CSS extraction', () => {
  it('normalizes canonical break-before/after values for column pagination', () => {
    const rules = extractBreakRulesFromCss(`
      .chapter {
        break-before: page;
        break-after: always;
      }
    `);

    expect(rules).toEqual([
      '.chapter { break-before: column; break-after: column; }',
    ]);
  });

  it('keeps alias declarations while preserving canonical mapped break hints', () => {
    const rules = extractBreakRulesFromCss(`
      .chapter {
        page-break-before: always;
        page-break-after: left;
      }
    `);

    expect(rules).toEqual([
      '.chapter { page-break-before: always; break-before: column; page-break-after: left; break-after: column; }',
    ]);
  });

  it('maps canonical avoid-page to avoid while still emitting alias-derived mapping', () => {
    const rules = extractBreakRulesFromCss(`
      .chapter {
        break-after: avoid-page !important;
        page-break-after: always;
      }
    `);

    expect(rules).toEqual([
      '.chapter { break-after: avoid !important; page-break-after: always; break-after: column; }',
    ]);
  });
});

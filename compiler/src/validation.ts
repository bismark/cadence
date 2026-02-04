/**
 * Runtime validation for compilation output
 */

import { getContentArea } from './device-profiles/profiles.js';
import type { DeviceProfile, Page, Span, ValidationResult } from './types.js';

/**
 * Validate compilation output and return any issues found
 */
export function validateCompilationResult(
  spans: Span[],
  pages: Page[],
  spanToPageIndex: Map<string, number>,
  profile: DeviceProfile,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const contentArea = getContentArea(profile);

  // Check 1: At least one span was extracted
  if (spans.length === 0) {
    errors.push('No spans were extracted from the EPUB');
  }

  // Check 2: At least one page was generated
  if (pages.length === 0) {
    errors.push('No pages were generated');
  }

  // Check 3: No duplicate span IDs
  const spanIds = new Set<string>();
  for (const span of spans) {
    if (spanIds.has(span.id)) {
      errors.push(`Duplicate span ID: "${span.id}"`);
    }
    spanIds.add(span.id);
  }

  // Check 4: Every span has a page assignment
  let unassignedCount = 0;
  for (const span of spans) {
    const pageIndex = spanToPageIndex.get(span.id);
    if (pageIndex === undefined || pageIndex < 0) {
      unassignedCount++;
    }
  }
  if (unassignedCount > 0) {
    warnings.push(
      `${unassignedCount} span${unassignedCount > 1 ? 's have' : ' has'} no page assignment`,
    );
  }

  // Check 5-7: Validate all rects on all pages
  for (const page of pages) {
    for (const spanRect of page.spanRects) {
      for (const rect of spanRect.rects) {
        // Check: Positive width/height
        if (rect.width <= 0) {
          warnings.push(`Rect for span "${spanRect.spanId}" has non-positive width: ${rect.width}`);
        }
        if (rect.height <= 0) {
          warnings.push(
            `Rect for span "${spanRect.spanId}" has non-positive height: ${rect.height}`,
          );
        }

        // Check: x,y >= 0
        if (rect.x < 0) {
          warnings.push(`Rect for span "${spanRect.spanId}" has negative x: ${rect.x}`);
        }
        if (rect.y < 0) {
          warnings.push(`Rect for span "${spanRect.spanId}" has negative y: ${rect.y}`);
        }

        // Check: Fits within content bounds
        if (rect.x + rect.width > contentArea.width) {
          warnings.push(
            `Rect for span "${spanRect.spanId}" extends beyond content width ` +
              `(${rect.x + rect.width} > ${contentArea.width})`,
          );
        }
        if (rect.y + rect.height > contentArea.height) {
          warnings.push(
            `Rect for span "${spanRect.spanId}" extends beyond content height ` +
              `(${rect.y + rect.height} > ${contentArea.height})`,
          );
        }
      }
    }

    // Check 8: Page has text runs
    if (page.textRuns.length === 0) {
      warnings.push(`Page "${page.pageId}" has no text runs`);
    }

    // Check 9: Validate text run positions
    for (const run of page.textRuns) {
      if (run.width <= 0 || run.height <= 0) {
        warnings.push(`Text run on page "${page.pageId}" has non-positive dimensions`);
      }
      if (run.x < 0 || run.y < 0) {
        warnings.push(`Text run on page "${page.pageId}" has negative position`);
      }
      if (run.y + run.height > contentArea.height) {
        warnings.push(`Text run on page "${page.pageId}" extends beyond content bounds`);
      }
    }
  }

  // Check 10: Total text content exists
  const totalTextRuns = pages.reduce((sum, p) => sum + p.textRuns.length, 0);
  if (totalTextRuns === 0) {
    errors.push('No text runs were extracted from any page');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Log validation results to console
 */
export function logValidationResult(result: ValidationResult): void {
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.log(`  Error: ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.log(`  Warning: ${warning}`);
    }
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('  All checks passed');
  }
}

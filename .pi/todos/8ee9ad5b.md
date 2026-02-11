{
  "id": "8ee9ad5b",
  "title": "[P2] Fail fast on missing pagination-critical EPUB resources",
  "tags": [
    "compiler",
    "reliability",
    "pagination",
    "p2"
  ],
  "status": "closed",
  "created_at": "2026-02-10T05:56:49.084Z"
}

`setupEpubResourceRouting()` currently logs missing resource warnings and fulfills with 404, then continues pagination. Missing CSS/fonts can change layout geometry and produce incorrect span/page mapping while the compile still reports success.

## Why this matters
Silent degraded pagination increases operational risk and makes sync/layout regressions hard to detect.

## Scope
- `compiler/src/layout/paginate.ts` route handler behavior for missing resources

## Acceptance criteria
- Missing critical resources (at least CSS and fonts) cause compile failure with a clear error.
- Error messages include chapter/source context for debugging.
- Optional: keep non-critical assets (e.g., some images) as warnings if explicitly desired, but document policy.
- Add tests that assert compile fails when a referenced stylesheet/font is missing.

Implemented alongside pagination request hardening.

### Changes
- Added critical-resource policy in `compiler/src/layout/paginate.ts`:
  - new helper `isCriticalPaginationResource()` treats CSS/fonts as critical (`stylesheet`/`font` resource types, plus `.css/.ttf/.otf/.woff/.woff2` extensions)
  - missing critical EPUB resources are recorded as **fatal** diagnostics
  - missing non-critical resources remain **warnings**
- Added fail-fast behavior:
  - `paginateContent()` checks diagnostics after content load (and during extraction loop)
  - fatal diagnostics trigger `throwOnPaginationRoutingFailures()` with clear chapter-specific error output
- Added tests in `compiler/test/pagination-resource-policy.test.ts`:
  - missing stylesheet is fatal and routed as 404, and failure helper throws
  - missing non-critical image is warning-only

### Verification
- `cd compiler && npm test` ✅
- `cd compiler && npx tsc --noEmit src/layout/paginate.ts ...` ✅ (targeted type-check of modified module)
- `cd compiler && npm run build` currently fails in unrelated pre-existing files (`src/bundle/writer.ts`, `src/types.ts`, `src/index.ts`) due workspace state outside this change.

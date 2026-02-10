{
  "id": "8ee9ad5b",
  "title": "[P2] Fail fast on missing pagination-critical EPUB resources",
  "tags": [
    "compiler",
    "reliability",
    "pagination",
    "p2"
  ],
  "status": "open",
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

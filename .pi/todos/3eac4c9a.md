{
  "id": "3eac4c9a",
  "title": "Honor generic CSS page-break hints in aligned pagination",
  "tags": [
    "compiler",
    "pagination",
    "align"
  ],
  "status": "closed",
  "created_at": "2026-02-10T22:09:25.130Z"
}

Implemented generic CSS-break driven pagination for align flow.

## What changed
- Extract break hints from chapter XHTML inline + linked stylesheets in `compiler/src/index.ts`.
- Preserve only generic break directives:
  - `break-before` / `break-after`
  - `page-break-before` / `page-break-after`
  - `column-break-before` / `column-break-after`
  - `-webkit-column-break-before` / `-webkit-column-break-after`
- Canonicalize legacy/page/column values into column-friendly `break-before/after` equivalents.
- Inject extracted break-only CSS into normalized aligned HTML.
- Removed heuristic chapter break injection from `compiler/src/layout/paginate.ts`.
- Added post-extraction compaction in paginator to drop truly empty pages (no `textRuns`, no `spanRects`) and renumber chapter-local page ids/indexes.

## Validation
- `cd compiler && npm run build`
- `cd compiler && npm test`
- Rebuilt aligned fixture bundle (`/private/tmp/moby-dick-aligned-render-fidelity-v19.bundle`).
- Verified page 22 is no longer blank on device.
- Verified blank-page count in bundle pages is 0.
- Verified frontmatter/title split now follows source break hints (title page moved after frontmatter).

## Result
- Pagination now follows source-authored break semantics generically (no PG-specific rules).
- Empty interstitial pages from spacer+forced-break interaction are removed.

## Follow-up (strict no-PG-specific logic)
- Removed remaining `chapterId === 'pg-header'` typography branch from `generateNormalizedAlignedHTML` in `compiler/src/index.ts`.
- Rebuilt as `/private/tmp/moby-dick-aligned-render-fidelity-v20.bundle` and pushed to emulator.
- Verified opener pagination remains correct (frontmatter -> title -> byline/contents) with no hardcoded PG conditions.
- Cleaned old interim bundle `/private/tmp/moby-dick-aligned-render-fidelity-v19.bundle`; only v20 remains.

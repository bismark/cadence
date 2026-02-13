{
  "id": "ebabe91a",
  "title": "[P0] Player renderer cleanup: remove margin/baseline heuristics and draw precomputed ops only",
  "tags": [
    "player",
    "rendering",
    "p0"
  ],
  "status": "closed",
  "created_at": "2026-02-10T06:10:03.891Z"
}

Maintain the architecture rule: **player is a dumb painter**.

Current issue:
- `PageRenderer.kt` hardcodes margins and estimates baseline (`height * 0.8f`).

Scope:
- Remove hardcoded `marginLeft`/`marginTop` rendering assumptions.
- Use bundle-provided content origin/margins/coordinates only.
- Draw each run at compiler-provided positions (`baselineY` once available), with no typographic/layout calculations.
- Keep runtime focused on painting + hit-testing only.

Acceptance criteria:
- No baseline estimation math in player renderer.
- No fallback text layout calculations in player.
- Visual output aligns with compiler preview for same page data.

## Completion notes (2026-02-12)
- Updated player `PageRenderer` to remove hardcoded `marginLeft`/`marginTop` assumptions.
- Renderer and hit-testing now use bundle-provided `page.contentX` / `page.contentY`.
- Extended player page model + JSON loader (`Bundle.kt`, `BundleLoader.kt`) to require `contentX` / `contentY` from bundle pages.
- Rendering remains paint-only: text draw uses compiler-provided `baselineY` with no runtime baseline/layout fallback.

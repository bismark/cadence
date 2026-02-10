{
  "id": "d947eccf",
  "title": "[P0] Compiler renderer fidelity: preserve exact whitespace and line text extraction",
  "tags": [
    "compiler",
    "rendering",
    "typography",
    "p0"
  ],
  "status": "closed",
  "created_at": "2026-02-10T06:10:03.877Z"
}

Maintain the architecture rule: **player is a dumb painter**.

Current issue:
- `compiler/src/layout/paginate.ts` reconstructs line text via caret probing and normalizes whitespace (`replace(/\s+/g, ' ')`), which can drift from browser layout fidelity.

Scope:
- Remove whitespace collapsing in text extraction.
- Replace fragile caret-based line reconstruction with extraction that preserves original glyph/space/punctuation ordering as laid out by Chromium.
- Ensure text runs emitted to bundle reflect exact browser text for each rect.

Acceptance criteria:
- No whitespace normalization in pagination extraction path.
- Moby Dick sample pages (including page with EXTRACTS section) visually match browser/Thorium line text + spacing much more closely.
- Player requires no text reconstruction logic.

Implemented in `compiler/src/layout/paginate.ts`:

- Removed caret-based line text reconstruction (`caretRangeFromPoint`) entirely.
- Removed whitespace normalization (`replace(/\s+/g, ' ')`) from pagination extraction path.
- Replaced extraction with glyph-order scanning by rendered codepoint ranges (`Range.setStart/setEnd + getClientRects`) so emitted text follows Chromium layout order.
- Added whitespace handling to reflect rendered output instead of source formatting noise:
  - normalize rendered whitespace glyphs to `' '`
  - ignore collapsed near-zero-width whitespace (`<= 0.5px`)
  - collapse duplicate whitespace that maps to the same rendered rect.
- Kept column assignment by line-start (with left tolerance) and clamped page-local x as part of ongoing fidelity work.

Validation run:
- `cd compiler && npm run build`
- `cd compiler && npm test`
- `cd compiler && node dist/index.js align -e test/fixtures/moby-dick.epub -a test/fixtures/mobydick_001_002_melville.mp3 --transcription test/fixtures/mobydick-transcription.json --no-zip -o /tmp/moby-dick-aligned-render-fidelity-v5.bundle`

Spot check (EXTRACTS pages) in `/tmp/moby-dick-aligned-render-fidelity-v5.bundle/pages/7.json` now shows cleaned line text (no embedded `\n`, no synthetic doubled spaces from collapsed source indentation) and preserved inter-run spacing consistent with rendered geometry.

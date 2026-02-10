{
  "id": "d947eccf",
  "title": "[P0] Compiler renderer fidelity: preserve exact whitespace and line text extraction",
  "tags": [
    "compiler",
    "rendering",
    "typography",
    "p0"
  ],
  "status": "open",
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

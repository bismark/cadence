{
  "id": "dddf9df2",
  "title": "Compiler: load EPUB resources in Chromium with real relative URL resolution",
  "tags": [
    "compiler",
    "epub",
    "p0"
  ],
  "status": "closed",
  "created_at": "2026-02-06T16:24:27.564Z"
}

Set up Playwright rendering so XHTML/CSS/images/fonts resolve exactly as they do inside the EPUB package (instead of relying on `setContent` without a package URL context).

## Why
Current layout fidelity is limited when publisher assets are referenced relatively.

## Acceptance criteria
- XHTML/CSS loaded with a stable base URL rooted at EPUB package path.
- Relative asset refs (`url(...)`, `<img src>`, `@font-face src`) resolve during layout.
- Missing-resource cases are reported with clear warnings.

## Implementation notes (2026-02-09)
- Added stable virtual origin routing for Playwright pagination: `https://epub.local/...` maps to EPUB container resources.
- Added base URL injection per chapter (`xhtmlPath`-derived) so relative refs resolve under the chapter directory.
- Normalization now tracks `xhtmlPath` in `NormalizedContent`.
- Normalization now carries stylesheet links from XHTML `<head>` into generated HTML so linked CSS is actually loaded in Chromium.
- Added missing-resource warnings during pagination with chapter + source context.
- Added regression test: `compiler/test/xhtml-normalization.test.ts` to verify stylesheet link preservation and source path metadata.
- Verified with build + test + compile run on `Advanced-Accessibility-Tests-Media-Overlays-v1.0.0.epub`.

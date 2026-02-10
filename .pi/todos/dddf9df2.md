{
  "id": "dddf9df2",
  "title": "Compiler: load EPUB resources in Chromium with real relative URL resolution",
  "tags": [
    "compiler",
    "epub",
    "p0"
  ],
  "status": "open",
  "created_at": "2026-02-06T16:24:27.564Z"
}

Set up Playwright rendering so XHTML/CSS/images/fonts resolve exactly as they do inside the EPUB package (instead of relying on `setContent` without a package URL context).

## Why
Current layout fidelity is limited when publisher assets are referenced relatively.

## Acceptance criteria
- XHTML/CSS loaded with a stable base URL rooted at EPUB package path.
- Relative asset refs (`url(...)`, `<img src>`, `@font-face src`) resolve during layout.
- Missing-resource cases are reported with clear warnings.

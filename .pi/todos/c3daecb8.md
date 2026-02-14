{
  "id": "c3daecb8",
  "title": "[P2] Avoid regex-based style extraction from non-style contexts",
  "tags": [
    "compiler",
    "review",
    "security",
    "css",
    "p2"
  ],
  "status": "closed",
  "created_at": "2026-02-13T20:03:37.634Z"
}

## Context
Code review on diff vs `reviewed` found inline stylesheet extraction scans full raw XHTML using regex.

## Problem
`/<style...>(...)</style>/gi` over the full document can match fake `<style>` tags inside script/template/comment text. Those matches are then injected into normalized `<head>`, unintentionally activating CSS that was never a real style element.

## Location
- `compiler/src/epub/xhtml.ts`
  - `extractPublisherStylesFromRawHTML` (`styleTagRegex.exec(html)`)

## Expected fix
Extract inline styles from parsed DOM nodes (actual `<style>` elements), or at minimum constrain matching to real head/body element content in a way that cannot match script text.

## Suggested acceptance criteria
- Add regression test where script text contains `'<style>...</style>'`; normalized HTML must not include that CSS.
- Real inline `<style>` elements are still extracted and sanitized as before.

### Completed
- Removed regex-based full-document inline-style harvesting in `compiler/src/epub/xhtml.ts`:
  - no global `/<style...>(...)</style>/gi` scan over raw XHTML,
  - extraction now parses only the `<head>` fragment and walks actual element nodes in-order.
- As a result, fake `<style>...</style>` text inside script/template/comment payloads is not treated as a real style node and is not injected into normalized head output.
- Added regression test in `compiler/test/xhtml-normalization.test.ts`:
  - `ignores fake <style> tags inside script text while still extracting real inline styles`
  - verifies script string containing `<style>...` is ignored,
  - verifies real inline `<style>` is still extracted.
- Verified with:
  - `cd compiler && npm test -- xhtml-normalization.test.ts`
  - `cd compiler && npm test`
  - `cd compiler && npm run build`
  - `cd compiler && npx biome check src/epub/xhtml.ts test/xhtml-normalization.test.ts`

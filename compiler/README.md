# Cadence Compiler

Compiles EPUB3 Media Overlays into Cadence bundles for synchronized text+audio playback.

## Prerequisites

- Node.js 18+
- npm

## Installation

```bash
npm install
npx playwright install chromium
```

## Building

```bash
npm run build
```

## Usage

```bash
# Compile an EPUB to a ZIP bundle
node dist/index.js compile -i path/to/book.epub

# Compile to uncompressed directory (useful for debugging)
node dist/index.js compile -i path/to/book.epub --no-zip

# Specify output path
node dist/index.js compile -i path/to/book.epub -o output.bundle.zip

# Use a specific device profile
node dist/index.js compile -i path/to/book.epub -p supernote-manta-a5x2

# Enable strict SMIL target validation (fail build on unresolved targets)
node dist/index.js compile -i path/to/book.epub --strict
```

## Publisher CSS handling (reflowable content)

For `compile` builds, Cadence preserves publisher styling by default and applies a safety filter before pagination.

CSS precedence order in normalized chapter HTML:

1. Linked publisher stylesheets (`<link rel="stylesheet">`) with package-local hrefs
2. Publisher inline `<style>` blocks (sanitized)
3. Cadence profile CSS overrides (authoritative for viewport, margins, and base font policy)

Safety filter behavior:

- Reject stylesheet links with protocol/absolute origins (e.g. `https://...`, `data:...`, `javascript:...`)
- Remove unsafe `@import` targets and rewrite unsafe `url(...)` values to `url("")`
- Strip legacy scriptable CSS declarations (e.g. `behavior`, `-moz-binding`, `expression(...)`)
- Drop HTML event-handler attributes (e.g. `onclick`) and `javascript:` / `vbscript:` URL attributes during XHTML normalization

This keeps useful book CSS in place while enforcing Cadence’s device-profile layout envelope.

## Running Tests

### Manual Testing

Run the compiler on the test EPUB with media overlays:

```bash
npm run build
node dist/index.js compile -i test/fixtures/Advanced-Accessibility-Tests-Media-Overlays-v1.0.0.epub --no-zip
```

Expected output:
```
Cadence Compiler v0.1.0
========================
...
Step 9: Validating output...
  All checks passed

Compilation complete!
  Chapters: 3
  Pages: 10
  Spans: 121
```

### Validation

The compiler runs automatic validation checks in two phases:

1. **SMIL-to-DOM target validation (Step 5b)**
   - `textRef` includes a fragment target (`#id`)
   - `textRef` path matches the chapter XHTML being compiled
   - Target fragment exists in chapter XHTML
   - Timed spans map to rendered geometry/text in paginated pages

2. **Bundle geometry/output validation (Step 9)**
   - At least one span was extracted
   - At least one page was generated
   - No duplicate span IDs
   - Every span has a page assignment
   - All rects have positive width/height
   - All rects have non-negative x,y coordinates
   - All rects fit within content bounds

By default, validation issues are logged as warnings.

Use `--strict` to fail compilation when SMIL target validation finds unresolved targets or timed spans without mapped geometry/text.

### Inspecting Output

After compiling with `--no-zip`, inspect the bundle directory:

```bash
# View metadata
cat test/fixtures/Advanced-Accessibility-Tests-Media-Overlays-v1.0.0.bundle/meta.json

# View spans
head test/fixtures/Advanced-Accessibility-Tests-Media-Overlays-v1.0.0.bundle/spans.jsonl

# View a page's span rectangles
cat test/fixtures/Advanced-Accessibility-Tests-Media-Overlays-v1.0.0.bundle/pages/tobi_spine_3_p0001.json
```

## Project Structure

```
src/
  index.ts           # CLI entry point
  types.ts           # TypeScript interfaces
  validation.ts      # Output validation
  validation/
    smil-targets.ts  # SMIL textRef/DOM target validation
  epub/
    container.ts     # EPUB ZIP reading
    opf.ts           # OPF package parsing
    smil.ts          # SMIL media overlay parsing
    xhtml.ts         # XHTML normalization
  layout/
    paginate.ts      # Playwright-based pagination
  bundle/
    writer.ts        # Bundle output
  device-profiles/
    profiles.ts      # Device configurations
```

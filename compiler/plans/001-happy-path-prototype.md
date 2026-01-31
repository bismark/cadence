# Cadence Compiler - Happy Path Prototype Plan

## Goal

Build a minimal working EPUB3 Media Overlays compiler that can:
1. Parse a single EPUB with media overlays
2. Extract text + audio timing from SMIL
3. Paginate for Supernote Manta screen dimensions
4. Output a compiled bundle with highlight rectangles

## Target Device Profile

**Supernote Manta A5 X2**
- Screen: 1920 × 2560 px
- PPI: 300
- Physical: 10.7" diagonal

## Test Fixture

**EPUB Test Book**: [Fundamental Accessibility Tests: Read Aloud v2.0.0](https://epubtest.org/test-books/read-aloud/2.0.0)
- Contains SMIL media overlays
- Tests read-aloud, pause/resume, text highlighting
- Download from GitHub releases

## Architecture (Simplified for Prototype)

```
book.epub → [Parse] → [Paginate] → book.bundle.zip
              │           │
              ▼           ▼
         spans.json   pages/*.json
         (timing)     (rects)
```

## Tech Stack

| Component | Library |
|-----------|---------|
| Runtime | Node.js LTS + TypeScript |
| EPUB/ZIP | yauzl |
| XML (OPF/SMIL) | fast-xml-parser |
| XHTML | parse5 |
| Layout | Playwright (Chromium) |
| CLI | commander |

## Project Structure

```
/compiler
  /src
    index.ts              # CLI entrypoint
    epub/
      container.ts        # Open EPUB, read files
      opf.ts              # Parse OPF manifest/spine
      smil.ts             # Parse SMIL timing
      xhtml.ts            # Parse/normalize XHTML
    layout/
      paginate.ts         # Playwright pagination + rect extraction
    bundle/
      writer.ts           # Output bundle ZIP
    types.ts              # Shared TypeScript interfaces
    device-profiles/
      manta.ts            # Manta screen config
  /test
    /fixtures             # Downloaded test EPUB
  package.json
  tsconfig.json
```

## Implementation Steps

### Step 1: Project Setup
- Initialize git repo
- Create package.json with dependencies:
  - `typescript`, `tsx` (dev)
  - `yauzl`, `fast-xml-parser`, `parse5`
  - `playwright`
  - `commander`
- Create tsconfig.json
- Create basic directory structure
- Add .gitignore

### Step 2: TypeScript Interfaces
Define core types in `types.ts`:
```typescript
interface DeviceProfile {
  name: string;
  viewportWidth: number;
  viewportHeight: number;
  margins: { top, right, bottom, left };
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
}

interface Span {
  id: string;
  chapterId: string;
  textRef: string;       // XHTML fragment reference
  audioSrc: string;
  clipBeginMs: number;
  clipEndMs: number;
}

interface PageSpanRect {
  spanId: string;
  rects: Array<{ x, y, width, height }>;
}

interface Page {
  pageId: string;
  chapterId: string;
  pageIndex: number;
  spanRects: PageSpanRect[];
  firstSpanId: string;
  lastSpanId: string;
}
```

### Step 3: EPUB Container Reader
`epub/container.ts`:
- Open EPUB as ZIP using yauzl
- Read `META-INF/container.xml` to find OPF path
- Provide `readFile(path): Promise<Buffer>` helper

### Step 4: OPF Parser
`epub/opf.ts`:
- Parse OPF manifest to get:
  - Spine order (list of XHTML files)
  - Media overlay references (which SMIL files map to which chapters)
  - Audio file manifest entries

### Step 5: SMIL Parser
`epub/smil.ts`:
- Parse each SMIL file
- Extract `<par>` elements with:
  - `text src="chapter.xhtml#fragment-id"`
  - `audio src="audio.mp3" clipBegin="0s" clipEnd="2.5s"`
- Convert clip times to milliseconds
- Output ordered list of Span objects

### Step 6: XHTML Normalization
`epub/xhtml.ts`:
- Parse XHTML with parse5
- Extract text content preserving IDs referenced by SMIL
- Generate "clean" HTML for Playwright rendering:
  - Wrap each SMIL-referenced element with `data-span-id`
  - Strip unsupported elements
  - Apply fixed typography CSS

### Step 7: Playwright Pagination
`layout/paginate.ts`:
- Launch headless Chromium via Playwright
- Set viewport to Manta dimensions (1920 × 2560)
- Load normalized HTML with fixed CSS
- Implement pagination:
  - Use CSS multi-column or manual height-based splitting
  - Detect which spans appear on which page
- Extract rectangles:
  - For each `[data-span-id]` element, call `element.getBoundingClientRect()`
  - Convert to page-local coordinates
- Return array of Page objects

### Step 8: Bundle Writer
`bundle/writer.ts`:
- Create ZIP file with structure:
  ```
  meta.json       # { profile, chapterCount, pageCount, spanCount }
  spans.jsonl     # One span per line with timing
  pages/
    ch0_p0001.json
    ...
  audio/
    *.mp3         # Copied from EPUB
  ```

### Step 9: CLI Integration
`index.ts`:
- Wire up commander CLI
- Basic command: `npx tsx src/index.ts compile --input book.epub --output book.bundle.zip`
- Log progress to console

## Manta Device Profile

```typescript
// device-profiles/manta.ts
export const mantaProfile: DeviceProfile = {
  name: 'supernote-manta-a5x2',
  viewportWidth: 1920,
  viewportHeight: 2560,
  margins: { top: 100, right: 80, bottom: 100, left: 80 },
  fontSize: 48,        // Large for 300 PPI
  lineHeight: 1.5,
  fontFamily: 'serif', // Will use system serif
};
```

## Output Bundle Format (v1 - JSON)

**meta.json**
```json
{
  "bundleVersion": "1.0.0",
  "profile": "supernote-manta-a5x2",
  "title": "Book Title",
  "chapters": 1,
  "pages": 10,
  "spans": 45
}
```

**spans.jsonl** (one per line)
```json
{"id":"s1","chapterId":"ch0","audioSrc":"audio/001.mp3","clipBeginMs":0,"clipEndMs":2500,"pageId":"ch0_p0001"}
```

**pages/ch0_p0001.json**
```json
{
  "pageId": "ch0_p0001",
  "chapterId": "ch0",
  "pageIndex": 0,
  "firstSpanId": "s1",
  "lastSpanId": "s3",
  "spanRects": [
    { "spanId": "s1", "rects": [{ "x": 80, "y": 100, "width": 400, "height": 72 }] },
    { "spanId": "s2", "rects": [{ "x": 80, "y": 172, "width": 380, "height": 72 }] }
  ]
}
```

## Verification

1. **Manual inspection**: Run compiler on test EPUB, inspect JSON output
2. **Span coverage**: Every SMIL `<par>` should have a corresponding span in output
3. **Rect sanity**: All rects should be within viewport bounds
4. **Audio files**: All referenced audio files copied to bundle

## What's Deferred (Post-Prototype)

- [ ] Multi-chapter support (prototype may only handle first chapter)
- [ ] Docker containerization
- [ ] Font bundling for determinism
- [ ] Binary output format
- [ ] Automated tests / golden snapshots
- [ ] --validate-only and --strict modes
- [ ] TOC generation
- [ ] Error recovery / graceful degradation

## Files to Create

1. `package.json` - dependencies and scripts
2. `tsconfig.json` - TypeScript config
3. `.gitignore` - node_modules, dist, etc.
4. `src/index.ts` - CLI entrypoint
5. `src/types.ts` - TypeScript interfaces
6. `src/device-profiles/manta.ts` - device config
7. `src/epub/container.ts` - EPUB ZIP handling
8. `src/epub/opf.ts` - OPF parsing
9. `src/epub/smil.ts` - SMIL parsing
10. `src/epub/xhtml.ts` - XHTML normalization
11. `src/layout/paginate.ts` - Playwright pagination
12. `src/bundle/writer.ts` - bundle output

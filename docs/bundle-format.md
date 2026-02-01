# Cadence Bundle Format

A Cadence bundle is a directory (or ZIP file) containing precomputed layout data and audio for synchronized audiobook playback.

## Directory Structure

```
book.bundle/
├── meta.json           # Bundle metadata
├── spans.jsonl         # Timing data for each text segment (one per line)
├── audio.opus          # Single concatenated audio file (OGG Opus @ 48kbps)
└── pages/
    ├── chapter1_p0001.json
    ├── chapter1_p0002.json
    └── ...             # One file per page with layout data
```

## meta.json

Bundle metadata and summary statistics.

```json
{
  "bundleVersion": "1.0",
  "bundleId": "urn:isbn:9780123456789",
  "profile": "supernote-manta-a5x2",
  "title": "Moby Dick",
  "pages": 42,
  "spans": 1234
}
```

| Field | Type | Description |
|-------|------|-------------|
| `bundleVersion` | string | Bundle format version |
| `bundleId` | string | Stable book identifier (from `dc:identifier` or SHA256 hash) |
| `profile` | string | Device profile used for layout |
| `title` | string | Book title from EPUB metadata |
| `pages` | number | Total page count |
| `spans` | number | Total span (audio segment) count |

### bundleId Generation

The `bundleId` uniquely identifies a book for position persistence:
1. If EPUB has `dc:identifier` (often ISBN): use it directly
2. Otherwise: SHA256 hash of `title|spine_ids` (first 16 chars)

## spans.jsonl

One JSON object per line, each representing a synchronized text+audio segment. Lines are sorted by `clipBeginMs` for efficient binary search.

```jsonl
{"id":"span_ch1_0","clipBeginMs":0,"clipEndMs":3456.789,"pageIndex":0}
{"id":"span_ch1_1","clipBeginMs":3456.789,"clipEndMs":7890.123,"pageIndex":0}
{"id":"span_ch1_2","clipBeginMs":7890.123,"clipEndMs":12345.678,"pageIndex":1}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique span identifier (matches `spanId` in page data) |
| `clipBeginMs` | number | Start time in `audio.opus` (milliseconds, inclusive) |
| `clipEndMs` | number | End time in `audio.opus` (milliseconds, exclusive) |
| `pageIndex` | number | Global page index where this span appears |

### Notes

- Times are **global** offsets into the single `audio.opus` file
- Adjacent spans have touching boundaries (no gaps): span N's `clipEndMs` equals span N+1's `clipBeginMs`
- `pageIndex` refers to the page where the span's text is rendered

## audio.opus

Single concatenated audio file containing all chapter audio in spine order.

- **Format**: OGG container with Opus codec
- **Bitrate**: 48kbps (optimized for speech)
- **Channels**: Mono or stereo (preserves source)

The compiler concatenates individual chapter audio files and adjusts span timestamps accordingly.

## pages/*.json

One file per page containing precomputed layout data.

```json
{
  "pageId": "chapter1_p0001",
  "chapterId": "chapter1",
  "pageIndex": 0,
  "width": 1404,
  "height": 1872,
  "textRuns": [...],
  "spanRects": [...],
  "firstSpanId": "span_ch1_0",
  "lastSpanId": "span_ch1_5"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pageId` | string | Unique page identifier |
| `chapterId` | string | Chapter this page belongs to |
| `pageIndex` | number | Global page index (0-based) |
| `width` | number | Page width in pixels |
| `height` | number | Page height in pixels |
| `textRuns` | TextRun[] | Positioned text segments |
| `spanRects` | PageSpanRect[] | Highlight rectangles for each span |
| `firstSpanId` | string | First span ID on this page (for navigation) |
| `lastSpanId` | string | Last span ID on this page |

### TextRun

A positioned piece of text on the page.

```json
{
  "text": "Call me Ishmael.",
  "x": 72,
  "y": 150,
  "width": 180,
  "height": 24,
  "spanId": "span_ch1_0",
  "style": {
    "fontFamily": "serif",
    "fontSize": 18,
    "fontWeight": 400,
    "fontStyle": "normal",
    "color": "#000000"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | The text content |
| `x` | number | Left position in pixels |
| `y` | number | Top position in pixels |
| `width` | number | Width in pixels |
| `height` | number | Height in pixels |
| `spanId` | string? | Span ID if part of synchronized segment |
| `style` | TextStyle | Font and color information |

### PageSpanRect

Highlight rectangles for a span on this page. A span may have multiple rectangles if the text wraps across lines.

```json
{
  "spanId": "span_ch1_0",
  "rects": [
    {"x": 72, "y": 150, "width": 180, "height": 24},
    {"x": 72, "y": 174, "width": 120, "height": 24}
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `spanId` | string | Span identifier |
| `rects` | Rect[] | One or more rectangles covering the span's text |

### Rect

A simple rectangle.

```json
{"x": 72, "y": 150, "width": 180, "height": 24}
```

## Design Rationale

### Precomputed Layout
All text positioning and highlight geometry is computed at compile time using a headless browser (Playwright). This allows the player to render without a WebView or complex text layout engine—critical for fast performance on e-ink devices.

### Single Audio File
Chapter audio files are concatenated into one `audio.opus` file with adjusted timestamps. This eliminates complexity in the player for managing multiple audio sources and seeking across chapters.

### JSONL for Spans
Using newline-delimited JSON allows:
- Streaming/line-by-line parsing
- Binary search by timestamp (lines are sorted)
- Easy debugging (human-readable)

### OGG Opus Audio
- Opus provides excellent quality at 48kbps for speech
- Native Android support since API 21 (Android 5.0)
- Open format with no licensing issues

## Player Usage

1. Parse `meta.json` to get page/span counts
2. Load `spans.jsonl` into memory (or use streaming with binary search)
3. Load pages on demand from `pages/*.json`
4. Play `audio.opus` and poll position at ~20Hz
5. Binary search spans to find active span at current position
6. Draw page text and highlight rectangles for active span

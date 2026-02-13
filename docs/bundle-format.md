# Cadence Bundle Format

A Cadence bundle is a directory (or ZIP) containing precomputed page geometry and synchronized audio timing.

## Directory Structure

```text
book.bundle/
├── meta.json           # Bundle metadata
├── spans.jsonl         # Timing data (one JSON object per line)
├── styles.json         # Shared text style table (indexed by styleId)
├── audio.opus          # Single concatenated audio file (OGG Opus)
└── pages/
    ├── *.json          # One file per page (filename not semantically significant)
```

> Note: page filenames may differ by pipeline (`chapter_p0001.json` vs `0.json` etc.).
> The player reads all page JSON files and orders by each page's `pageIndex` field.

## meta.json

```json
{
  "bundleVersion": "1.0.0",
  "bundleId": "urn:isbn:9780123456789",
  "profile": "supernote-manta-a5x2",
  "title": "Moby Dick",
  "pages": 42,
  "spans": 1234
}
```

| Field | Type | Description |
|---|---|---|
| `bundleVersion` | string | Bundle format version string |
| `bundleId` | string | Stable book identifier (from `dc:identifier` or fallback hash) |
| `profile` | string | Device profile used for layout |
| `title` | string | Book title |
| `pages` | number | Total page count |
| `spans` | number | Total span count |

## spans.jsonl

One JSON object per line, sorted by `clipBeginMs`.

```jsonl
{"id":"s0","clipBeginMs":0,"clipEndMs":3456.789,"pageIndex":0}
{"id":"s1","clipBeginMs":3456.789,"clipEndMs":7890.123,"pageIndex":0}
{"id":"s2","clipBeginMs":7890.123,"clipEndMs":12345.678,"pageIndex":1}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Internal span identifier (matches page `spanId` references) |
| `clipBeginMs` | number | Start time in `audio.opus` (inclusive) |
| `clipEndMs` | number | End time in `audio.opus` (exclusive) |
| `pageIndex` | number | Global page index where span first appears |

Notes:
- Span IDs are compiler-assigned internal IDs (compact, deterministic per build).
- Times are global offsets into the single `audio.opus` file.

## styles.json

Shared style table for all pages.

```json
[
  {
    "fontFamily": "\"Noto Serif\", serif",
    "fontSize": 48,
    "fontWeight": 400,
    "fontStyle": "normal",
    "inkGray": 0
  },
  {
    "fontFamily": "\"Noto Serif\", serif",
    "fontSize": 72,
    "fontWeight": 700,
    "fontStyle": "normal",
    "inkGray": 0
  }
]
```

Each entry is a `TextStyle` object:

| Field | Type | Description |
|---|---|---|
| `fontFamily` | string | CSS font-family string captured from layout engine |
| `fontSize` | number | Font size in px |
| `fontWeight` | number | Numeric weight (e.g. 400, 700) |
| `fontStyle` | string | `"normal"` or `"italic"` |
| `inkGray` | number | Quantized e-ink gray (0=black, 255=white) |

## pages/*.json

Each page file contains geometry and text runs.

```json
{
  "pageId": "chapter1_p0001",
  "chapterId": "chapter1",
  "pageIndex": 0,
  "width": 1404,
  "height": 1872,
  "contentX": 80,
  "contentY": 100,
  "textRuns": [
    {
      "text": "Call me Ishmael.",
      "x": 72.125,
      "y": 150.5,
      "width": 180.75,
      "height": 24,
      "baselineY": 169.35,
      "spanId": "s0",
      "styleId": 0
    }
  ],
  "spanRects": [
    {
      "spanId": "s0",
      "rects": [
        { "x": 72.125, "y": 150.5, "width": 180.75, "height": 24 }
      ]
    }
  ],
  "firstSpanId": "s0",
  "lastSpanId": "s0"
}
```

### Page fields

| Field | Type | Description |
|---|---|---|
| `pageId` | string | Page identifier |
| `chapterId` | string | Source chapter identifier |
| `pageIndex` | number | Global 0-based index |
| `width` | number | Content width in px |
| `height` | number | Content height in px |
| `contentX` | number | Content area origin X in viewport coordinates |
| `contentY` | number | Content area origin Y in viewport coordinates |
| `textRuns` | TextRun[] | Positioned text runs (coordinates are page-local; add `contentX`/`contentY` for viewport placement) |
| `spanRects` | PageSpanRect[] | Highlight rectangles per span |
| `firstSpanId` | string | First span visible on page |
| `lastSpanId` | string | Last span visible on page |

### TextRun

| Field | Type | Description |
|---|---|---|
| `text` | string | Text content |
| `x` | number | Left position in page-local coords (float px) |
| `y` | number | Top position in page-local coords (float px) |
| `width` | number | Width (float px) |
| `height` | number | Height (float px) |
| `baselineY` | number | Baseline Y in page-local coordinates (float px) |
| `spanId` | string? | Span ID if synchronized |
| `styleId` | number | Index into `styles.json` |

### PageSpanRect

| Field | Type | Description |
|---|---|---|
| `spanId` | string | Span identifier |
| `rects` | Rect[] | One or more rectangles covering the span |

### Rect

| Field | Type | Description |
|---|---|---|
| `x` | number | Left (page-local float px) |
| `y` | number | Top (page-local float px) |
| `width` | number | Width (float px) |
| `height` | number | Height (float px) |

## audio.opus

Single concatenated audio file for the whole book.

- Format: OGG Opus
- Timestamps in `spans.jsonl` are offsets into this file

## Player Loading Sequence

1. Read `meta.json`.
2. Read `spans.jsonl`.
3. Read `styles.json`.
4. Read `pages/*.json` and resolve each `styleId` against the styles table.
5. Play `audio.opus` and find active span via timestamp lookup.

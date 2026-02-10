# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cadence is a two-part system for reading EPUB3 books with synchronized audio and text highlighting on e-ink devices (specifically the Supernote Manta). It consists of:

1. **Compiler** (TypeScript/Node.js) - Builds synchronized bundles either from EPUB3 Media Overlays (`compile`) or by aligning a plain EPUB to external audio (`align`)
2. **Player** (Kotlin/Android) - Plays bundles with synchronized audio and text highlighting

## Build Commands

### Compiler

```bash
cd compiler
npm install
npx playwright install chromium
npm run build
```

Compile an EPUB:
```bash
node dist/index.js compile -i path/to/book.epub --no-zip  # Directory output for debugging
node dist/index.js compile -i path/to/book.epub           # ZIP output
```

Test with included fixture:
```bash
node dist/index.js compile -i test/fixtures/Advanced-Accessibility-Tests-Media-Overlays-v1.0.0.epub --no-zip
```

Align fixture without embedded Media Overlays (Moby Dick):
```bash
node dist/index.js align -e test/fixtures/moby-dick.epub -a test/fixtures/mobydick_001_002_melville.mp3 --transcription test/fixtures/mobydick-transcription.json --no-zip -o test/fixtures/moby-dick-aligned.bundle.zip
```

Inspect a bundle:
```bash
node dist/index.js inspect -b path/to/book.bundle
```

Align an EPUB with an audiobook (parakeet-mlx):
```bash
node dist/index.js align -e book.epub -a audiobook.m4b -o book.bundle.zip
```

### Player

```bash
cd player
./gradlew assembleDebug
./gradlew installDebug  # Install on connected device
```

Push a bundle to device:
```bash
adb push book.bundle /sdcard/Download/cadence-bundle
adb shell am force-stop com.cadence.player
adb shell am start -n com.cadence.player/.MainActivity
```

Pi extension helper:
```bash
/push-bundle --bundle moby-dick
```

`/push-bundle` auto-starts an emulator when none is connected (defaults to AVD `Supernote_Manta_A5_X2`, override via `--avd <name>` or `CADENCE_AVD`).

## Agent Workflow Requirements

### Required verification for player changes

If you modify anything under `player/` (code, Gradle files, resources, or docs), run this before finishing:

```bash
cd player
./scripts/verify.sh
```

This command runs all required player checks:
- `:app:compileDebugKotlin`
- `detekt`
- `:app:lintDebug`
- `buildHealth`

Do not skip these checks unless the user explicitly asks to skip verification.

## Architecture

### Compilation Pipeline

The compiler transforms EPUBs through these stages:

1. **EPUB Parsing** (`epub/`) - Extract OPF manifest, spine order, and SMIL timing data
2. **XHTML Normalization** (`epub/xhtml.ts`) - Convert XHTML to limited HTML, inject span markers for timing sync
3. **Layout/Pagination** (`layout/paginate.ts`) - Render in headless Chromium via Playwright, capture exact text positions and highlight rectangles using `Range.getClientRects()`
4. **Bundle Writing** (`bundle/writer.ts`) - Output meta.json, spans.jsonl, pages/*.json, and audio files

### Bundle Format

```
book.bundle/
  meta.json          # Metadata: profile, title, chapter/page/span counts
  spans.jsonl        # One span per line (audio clip timing + page assignment)
  pages/*.json       # Precomputed text positions and highlight rects per page
  audio.opus         # Concatenated audio (Opus)
```

### Player Runtime

- **BundleLoader** loads JSON bundle into memory
- **PlayerScreen** maintains playback state, polls audio position at ~20Hz
- **PageRenderer** draws text runs and highlight rects on Compose Canvas (no WebView)
- **AudioPlayer** wraps ExoPlayer for audio playback

### Key Design Decisions

- **Playwright for layout**: Browser engine handles CSS edge cases and gives exact highlight geometry via `Range.getClientRects()`
- **Canvas rendering (not WebView)**: E-ink CPUs are weak; Canvas is faster and avoids GC pauses
- **JSONL for spans**: Fast line-by-line parsing, binary search friendly (sorted by time)
- **Precomputed everything**: Layout, pagination, rect geometry computed at compile time to keep runtime thin
- **parakeet-mlx offline**: Alignment runs with `HF_HUB_OFFLINE=1` (models must be cached)

## Device Profiles

Profiles define viewport size, margins, font settings. Currently supports `supernote-manta-a5x2`. Add new profiles in `compiler/src/device-profiles/profiles.ts`.

## Key Files

| Purpose | Location |
|---------|----------|
| CLI entry & pipeline | `compiler/src/index.ts` |
| Type definitions | `compiler/src/types.ts` |
| SMIL timing extraction | `compiler/src/epub/smil.ts` |
| Playwright pagination | `compiler/src/layout/paginate.ts` |
| Output validation | `compiler/src/validation.ts` |
| Player state machine | `player/app/.../ui/PlayerScreen.kt` |
| Canvas rendering | `player/app/.../ui/PageRenderer.kt` |
| Audio playback | `player/app/.../audio/AudioPlayer.kt` |
